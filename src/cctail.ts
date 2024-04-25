#!/usr/bin/env node

import { green, yellow } from 'colorette';
import fs from 'fs';
import moment from 'moment';
import path from 'path';
import prompts, { Choice } from 'prompts';
import s from 'underscore.string';
import yargs from 'yargs';

import logemitter from './lib/logemitter';
import logfetcher from './lib/logfetcher';
import LogFluent from './lib/logfluent';
import logger from './lib/logger';
import logparser from './lib/logparser';
import { DwJson, FluentConfig, LogConfig, LogFile, Profiles } from './lib/types';

let fluent: LogFluent;
let logConfig: LogConfig;
let profiles: Profiles;
let profile: DwJson;
let debug = false;
let interactive = true;
let pollingSeconds = 3;
let refreshLogListSeconds = 600;
let nextLogRefresh: moment.Moment;
// let latestCodeprofilerLogSent: LogFile;  Removed by the New Relic Fork
let latestCodeprofilerLogs = new Map<string, moment.Moment>();
let envVarPrefix = "ENV_";

let run = async function () {
  let packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  logger.log(logger.info, `cctail - v${packageJson.version}`);

  readLogConf();

  if (!profiles || Object.keys(profiles).length === 0) {
    logger.log(logger.warn, `No profiles in log.conf.json, checking for dw.json in path ${process.cwd()}\n`);
    readDwJson();
  }

  yargs.parserConfiguration({
    "parse-numbers": false
  });

  const args: any = yargs.argv

  if (args['d']) {
    debug = true;
  }

  let fileobjs: LogFile[] = [];
  if (interactive) {
    fileobjs = await interact(args._[0] as string);
  } else {
    fileobjs = await dontInteract(args._[0] as string);
  }

  if (fileobjs.length === 0) {
    logger.log(logger.error, 'ERROR: No logs selected or returned, exiting.');
    process.exit(-1);
  }

  setImmediate(pollLogs, fileobjs);
}

let dontInteract = async function (profilename?: string): Promise<LogFile[]> {
  if (!profile) {
    if (Object.keys(profiles).length === 1) {
      profile = profiles[Object.keys(profiles)[0]];
    } else if (!profilename) {
      logger.log(logger.error, 'ERROR: No profile selected, exiting.');
      process.exit(-1);
    } else if (!profiles[`${profilename}`]) {
      logger.log(logger.error, `ERROR: Specified profile ${profilename} not found.`);
      process.exit(-1);
    } else {
      profile = profiles[profilename];
      logger.log(logger.info, `Using profile ${profilename}.`);
    }

    setPollingInterval(profile);
    if (profile.refresh_loglist_interval) {
      refreshLogListSeconds = profile.refresh_loglist_interval;
      logger.log(logger.info, `Setting log list refresh interval (seconds): ${refreshLogListSeconds}`);
    } else {
      profile.refresh_loglist_interval = refreshLogListSeconds;
      logger.log(logger.info, `Using default log list refresh interval (seconds): ${refreshLogListSeconds}`);
    }
  }

  nextLogRefresh = moment().add(refreshLogListSeconds, 's');
  //let fileobjs = await getThatLogList(profile);   Removed by the New Relic Fork
  let logx: LogFile[] = [];
  // Removed by the New Relic Fork
  // if (profile.log_types && profile.log_types.length > 0) {
  //   for (let thisfile of fileobjs) {
  //     let logname = thisfile.log.substr(0, thisfile.log.indexOf('-'));
  //     if (profile.log_types.indexOf(logname) != -1) {
  //       logx.push(thisfile);
  //     }
  let logfileobjs = await getThatLogList(profile);
  let logfilenames: string[] = getFilenames(logfileobjs);

  if (profile.log_types ) {
    logger.log(logger.debug, "Log Filter is in effect.", debug, {
      log_filter: profile.log_types.join(', ')
    })
  }

  for(let logfilename of logfilenames) {
    if(!profile.log_types || (profile.log_types.length > 0 && profile.log_types.indexOf(logfilename.split('-')[0]) != -1)) {
        logger.log(logger.debug, 'Including log as it matched our filter.', debug, {
            log_file: logfileobjs[0].log,
            log_size: logfileobjs[0].size_string,
            log_date: logfileobjs[0].date.toString(),
            log_included: true
          }
        )
        logx.push(getLatestFile(logfileobjs, logfilename));
    } else if(!profile.log_types || (profile.log_types.length > 0 && !(profile.log_types.indexOf(logfilename.split('-')[0]) != -1))) {
        logger.log(logger.debug, 'Skipping log as it did not match our filter.', debug, {
          log_file: logfileobjs[0].log,
          log_size: logfileobjs[0].size_string,
          log_date: logfileobjs[0].date.toString(),
          log_included: false
        });      
    }
  }

  if (!profile.log_types || profile.log_types.indexOf('codeprofiler') > 0) {
    let cpfileobjs = await getThatLogList(profile, '.csv');
    if (cpfileobjs && cpfileobjs.length > 0) {
      // Removed by the New Relic Fork
      // let newestcpfile = cpfileobjs.reduce((newest, compare) => newest.date.isAfter(compare.date) ? newest : compare);
      // if (!latestCodeprofilerLogSent || newestcpfile.date.isAfter(latestCodeprofilerLogSent.date)) {
      //   logx.push(newestcpfile);
      //   latestCodeprofilerLogSent = newestcpfile;
      // }
      let cpfilenames = getFilenames(cpfileobjs);
      for(let cpfilename of cpfilenames) {
        let newestcpfile = getLatestFile(cpfileobjs, cpfilename)
        if(!latestCodeprofilerLogs.has(cpfilename) || newestcpfile.date.isAfter(latestCodeprofilerLogs.get(cpfilename))) {
          logx.push(newestcpfile);
          latestCodeprofilerLogs.set(cpfilename, newestcpfile.date);
        }
      } 
    }
  }
  logger.log(logger.debug, `Using this log list: ${JSON.stringify(logx.map(logfile => logfile.log), null, 2)}`, debug);
  return logx;
}

// New Function to get Filenames
let getFilenames = function(logobjs: LogFile[]): string[] {
  let outfilenames: string[] = [];
  for (let logobj of logobjs) {
    var logsegment = logobj.log.split('.')[0];
    if(outfilenames.indexOf(logsegment) == -1) {
      outfilenames.push(logsegment);
    }
  }
  return outfilenames;
}

let getLatestFile = function(logobjs: LogFile[], logstr: string): LogFile {
  let theselogfiles = logobjs.filter(logfile => logfile.log.indexOf(logstr) > -1);
  return theselogfiles.reduce((newest, compare) => newest.date.isAfter(compare.date) ? newest : compare);
}

let interact = async function (profilename?: string): Promise<LogFile[]> {
  if (!profile) {
    if (Object.keys(profiles).length === 1) {
      profile = profiles[Object.keys(profiles)[0]];
    } else {
      if (profilename === undefined) {
        const profileselection = await prompts({
          type: 'select',
          name: 'value',
          message: 'Select a profile:',
          choices: Object.keys(profiles).map(i => ({
            title: `  [${i}] ${profiles[i].hostname}`,
            value: `${i}`
          }))
        });
        profilename = profileselection.value;
      }

      if (!profilename) {
        logger.log(logger.error, 'ERROR: No profile selected, exiting.');
        process.exit(-1);
      }

      if (!profiles[`${profilename}`]) {
        logger.log(logger.error, `ERROR: Specified profile ${profilename} not found.`);
        process.exit(-1);
      }

      profile = profiles[profilename];
    }
    setPollingInterval(profile);
  }

  let fileobjs = await getThatLogList(profile);
  fileobjs.sort((a, b) => b.date.unix() - a.date.unix());

  let logx: LogFile[] = [];
  let logchoiche: Choice[] = [];

  for (let i in fileobjs) {
    let sizeformatted = s.lpad(fileobjs[i].size_string, 12);
    if (sizeformatted.trim() !== '0.0 kb') {
      sizeformatted = yellow(sizeformatted);
    }
    let dateformatted = s.lpad(fileobjs[i].date.format('YYYY-MM-DD HH:mm:ss'), 20);
    if (fileobjs[i].date.isSame(moment.utc(), 'hour')) {
      dateformatted = yellow(dateformatted);
    }
    let logname = s.rpad(fileobjs[i].log, 70);

    logname = logger.colorize(logname, logname);

    logchoiche.push({
      title: `${green(s.lpad(i, 2))} ${logname} ${sizeformatted}  ${dateformatted}`,
      value: i
    });
  }

  let logselection = await prompts({
    type: 'autocompleteMultiselect',
    name: 'value',
    message: `Select logs on [${green(profile.hostname)}]`,
    choices: logchoiche,
    // eslint-disable-next-line no-return-assign
    onState: ((statedata) => { statedata.value ? statedata.value.forEach((i: Choice) => i.title = `\n${i.title}`) : 'no selection' })
  });

  if (logselection.value) { // ctrl+c
    logselection.value.forEach((i: number) => {
      logx.push(fileobjs[i]);
    });
  }

  return logx;
}

let setPollingInterval = function (profile: DwJson) {
  if (profile.polling_interval) {
    pollingSeconds = profile.polling_interval;
    logger.log(logger.info, `Setting polling interval (seconds): ${pollingSeconds}`);
  } else {
    logger.log(logger.info, `Using default polling interval (seconds): ${pollingSeconds}`);
    profile.polling_interval = pollingSeconds;
  }
}


let getThatLogList = async function (profile: DwJson, filesuffix = ".log"): Promise<LogFile[]> {
  let fileobjs: LogFile[] = [];

  let data = '';

  if (filesuffix === ".csv") {
    data = await logfetcher.fetchLogList(profile, debug, 'codeprofiler');
  } else {
    data = await logfetcher.fetchLogList(profile, debug);
  }

  let regexp = new RegExp(`<a href="/on/demandware.servlet/webdav/Sites/Logs/(.*?)">[\\s\\S\\&\\?]*?<td align="right">(?:<tt>)?(.*?)(?:<\\/tt>)?</td>[\\s\\S\\&\\?]*?<td align="right"><tt>(.*?)</tt></td>`, 'gim');
  let match = regexp.exec(data);

  while (match != null) {
    let filedate = moment.utc(match[3]);
    if (match[1].substr(-4) === filesuffix && filedate.isSame(moment.utc(), 'day')) {
      fileobjs.push({
        log: match[1],
        size_string: match[2],
        date: moment.utc(match[3]),
        debug: debug
      });
      logger.log(logger.debug, `Available Log: ${match[1]}`, debug, { 
        log_file: match[1], 
        log_size: match[2], 
        log_date: moment.utc(match[3]).toString() 
      });
    }
    match = regexp.exec(data);
  }

  return fileobjs;
}

let pollLogs = async function (fileobjs: LogFile[], doRollover = false) {
  if (logfetcher.isUsingAPI(profile) && logfetcher.errorcount > logfetcher.errorlimit) {
    logger.log(logger.error, `Error count (${logfetcher.errorcount}) exceeded limit of ${logfetcher.errorlimit}, resetting Client API token.`);
    logfetcher.errorcount = 0;
    profile.token = null;
    await logfetcher.authorize(profile, debug);
  }

  if (!doRollover) {
    if (moment.utc().isAfter(fileobjs[0].date, 'day')) {
      logger.log(logger.info, 'Logs have rolled over, collecting last entries from old logs.');
      doRollover = true;
    } else {
      logger.log(logger.debug, 'Logs have not rolled over since last poll cycle.', debug);
      if (nextLogRefresh && moment().isSameOrAfter(nextLogRefresh)) {
        logger.log(logger.debug, 'Refreshing log list.', debug);
        let newfiles = await dontInteract();
        for (let newfile of newfiles) {
          if (!fileobjs.some(logfile => logfile.log === newfile.log)) {
            logger.log(logger.debug, `Added new log file: ${newfile.log}.`, debug);
            fileobjs.push(newfile);
          }
        }
      }
    }

    if (fluent) {
      // Removed by the New Relic Fork
      // fluent.output(profile.hostname,
      //   await logparser.process(fileobjs.map((logobj) => logfetcher.fetchLogContent(profile, logobj))),
      //   false, fileobjs[0].debug);
      for(let logobj of fileobjs) {
        var logobjarr = [];
        logobjarr.push(logfetcher.fetchLogContent(profile, logobj))
        fluent.output(profile.hostname, await logparser.process(logobjarr),
        false, logobj.debug);
      }
    } else {
      let parsed = logemitter.sort(
        await logparser.process(fileobjs.map((logobj) => logfetcher.fetchLogContent(profile, logobj)))
      );
      logemitter.output(parsed, false, fileobjs[0].debug);
    }

    // Removed by the New Relic Fork
    // Codeprofiler files should only be consumed once
    // let cp = fileobjs.findIndex(logobj => logobj.log.endsWith("csv"));
    // if (cp > -1) {
    //   logger.log(logger.debug, `Removed codeprofiler log ${fileobjs[cp].log} from list.`, debug);
    //   fileobjs.splice(cp, 1);
    // }
    // The above was removed by the newrelic-fork and replaced with:
    logger.log(logger.debug, `Removing code provider log from list: ${JSON.stringify(fileobjs.filter(logobj => logobj.log.endsWith("csv")), null, 2)}`, debug);
    fileobjs = fileobjs.filter(logobj => !logobj.log.endsWith("csv"));

  } else {
    if (interactive) {
      fileobjs = await interact();
    } else {
      fileobjs = await dontInteract();
    }

    if (fileobjs.length != 0) {
      doRollover = false;
      for (let i of fileobjs) {
        i.size = -1;
      }
    } else {
      logger.log(logger.warn, 'No logs to report yet, waiting until next cycle.');
    }
  }

  setTimeout(pollLogs, pollingSeconds * 1000, fileobjs, doRollover);
}

function replaceEnvPlaceholders(data: any) {
  Object.keys(data).forEach(function (key) {
    var value = data[key];
    if (typeof (value) === 'object') {
      replaceEnvPlaceholders(value);
    } else if (typeof (value) === 'string' && value.startsWith(envVarPrefix)) {
      var checkForVar = value.replace(envVarPrefix, "");
      if (process.env.hasOwnProperty(checkForVar)) {
        if (key === 'log_types') {
          const logtypes = process.env[checkForVar];
          if (logtypes) {
              data[key] = logtypes.split(',').map(item => item.trim());
          } else {
              logger.log(logger.error, `No data found for environment variable: ${checkForVar}.  Reverting to all logs.`);
              delete data[key];
          }
        } else {
          // normal variable
          data[key] = process.env[checkForVar];
        }
      }
    }
  });
  return data;
}

function readDwJson() {
  let dwJsonPath = path.join(process.cwd(), 'dw.json');
  logger.log(logger.info, `Loading profile from ${dwJsonPath}\n`);
  try {
    const dwJson = replaceEnvPlaceholders(JSON.parse(fs.readFileSync(dwJsonPath, 'utf8')));
    const name = dwJson.profile || dwJson.hostname.split('-')[0].split('-')[0];
    profiles[name] = dwJson;
  }
  catch (err) {
    logger.log(logger.error, `No dw.json found in path ${process.cwd()}\n`);
    process.exit(-1);
  }
}

function readLogConf() {
  try {
    logConfig = replaceEnvPlaceholders(JSON.parse(fs.readFileSync(`${process.cwd()}/log.conf.json`, 'utf8')));
    profiles = logConfig.profiles ?? logConfig as any; // support for old configs (without "profiles" group)
    if (logConfig.interactive !== undefined && logConfig.interactive === false) {
      interactive = false;
      logger.log(logger.info, "Interactive mode is disabled.");
    }
    if (logConfig.fluent && logConfig.fluent.enabled) {
      let fluentConfig: FluentConfig = logConfig.fluent;
      fluent = new LogFluent(fluentConfig);
      logger.log(logger.info, "FluentD output is enabled.");
    } else {
      logger.log(logger.info, "Console output is enabled.");
    }

  } catch (err) {
    logger.log(logger.error, `\nMissing or invalid log.conf.json.\nError message: ${err}\n`);
    process.exit(-1);
  }
}

run();

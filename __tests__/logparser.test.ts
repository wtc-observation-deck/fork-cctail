import fs from 'fs';
import logparser from '../src/lib/logparser';
import logemitter from '../src/lib/logemitter';
import { LogFile } from '../src/lib/types';
import moment from 'moment';

let jobcontent:string;
let files: Promise<[LogFile, string]>[];

beforeAll( () => {
  files = fs.readdirSync('__tests__/logs').map(name => { 
       
      return new Promise( (resolve) => {

        const logfile: LogFile = {
          log: `__tests__/logs/${name}`,
          date: moment(),
          debug: true, 
          size_string: "MB"
        }
  
        const content = fs.readFileSync(logfile.log, { encoding: 'utf-8'});

        return resolve([logfile, content]);
      });
    })
});

test('correct number of items when parsing a single file', () => {
  const foo: LogFile = {
    log: '__tests__/logs/sample-jobs.log',
    date: moment(),
    debug: true,
    size_string: '3MB'

  }
  let result = logparser.parseLog([foo,fs.readFileSync(foo.log, { encoding: 'utf-8'})]);
   expect(result.length).toBe(10);
});
test('message content is right', () => {
  const foo: LogFile = {
    log: '__tests__/logs/sample-warn.log',
    date: moment(),
    debug: true,
    size_string: '3MB'

  }
  let result = logparser.parseLog([foo,fs.readFileSync(foo.log, { encoding: 'utf-8'})]);

  expect(result[0].message).toBe('first line of log with missing info');
  expect(result[1].message).toBe('PipelineCallServlet|1692371210|Adyen-Notify|PipelineCall|RrCsCHDvb2 custom []  multiline start\nmultiline second line\nmultiline third line');
  expect(result[2].message).toBe('PipelineCallServlet|1692371210|Adyen-Notify|PipelineCall|RrCsCHDvb2 custom []  .*#GET#TOP <-> Adyen-Notify#POST#TOP');
  expect(result[4].message).toBe('PipelineCallServlet|899141122|Adyen-Notify|PipelineCall|GUfhepk_2C custom []  .*#GET#TOP <-> Adyen-Notify#POST#TOP\nlast line');
});

test('logs are sorted', () => {
  const foo: LogFile = {
    log: '__tests__/logs/sample-unsorted.log',
    date: moment(),
    debug: true,
    size_string: '3MB'

  }
  let result = logemitter.sort(logparser.parseLog([foo,fs.readFileSync(foo.log, { encoding: 'utf-8'})]));
  
  expect(result[0].message).toBe('one');
  expect(result[1].message).toBe('two');
  expect(result[2].message).toBe('three');
  expect(result[3].message).toBe('four');
});


test('parse multiple files', async () => {
  let parsed = await logparser.process(files);
  expect(parsed.length).toBe(23);
});
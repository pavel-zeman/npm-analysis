const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const util = require("util");
const process = require("process"); 
const execAsync = util.promisify(exec);

const scenarios = [
  { command: "install", cache: true, lockFile: false },
  { command: "install", cache: true, lockFile: false, options: "--prefer-online" },
  { command: "install", cache: true, lockFile: false, options: "--package-lock-only" },
  { command: "install", cache: true, lockFile: true },
  { command: "install", cache: true, lockFile: true, options: "--prefer-online" },
  { command: "install", cache: false, lockFile: false },
  { command: "install", cache: false, lockFile: false, options: "--package-lock-only" },
  { command: "install", cache: false, lockFile: true },
  { command: "ci", cache: false, lockFile: true },
  { command: "ci", cache: true, lockFile: true },
  { command: "update", cache: true, lockFile: false },
  { command: "update", cache: true, lockFile: false, options: "--prefer-online" },
  { command: "update", cache: true, lockFile: false, options: "--package-lock-only" },
  { command: "update", cache: true, lockFile: true },
  { command: "update", cache: true, lockFile: true, options: "--prefer-online" },
  { command: "update", cache: false, lockFile: false },
  { command: "update", cache: false, lockFile: false, options: "--package-lock-only" },
  { command: "update", cache: false, lockFile: true },
];

async function prepareData(scenario) {
  const { cache, lockFile } = scenario;
  // Reinitialize the cache
  await execAsync("npm cache clean --force");

  await execAsync("rm -rf node_modules package-lock.json");

  if (cache || lockFile) {
    await execAsync("npm install");
    await execAsync("rm -rf node_modules");
  }
  if (!cache) {
    await execAsync("npm cache clean --force");
  }
  if (!lockFile) {
    await execAsync("rm -f package-lock.json");
  }
}

function getFileNameForScenario(scenario) {
  const { command, cache, lockFile, options } = scenario;
  return `${command}-cache-${cache}-lockfile-${lockFile}${options ?? ""}`;
}

function writeLogToFile(scenario, log) {
  const fileName = path.join(__dirname, "logs", `${getFileNameForScenario(scenario)}.log`);
  fs.writeFileSync(fileName, log, "utf8");
}

function writeStatsToFile(scenario, stats) {
  const fileName = path.join(__dirname, "logs", `${getFileNameForScenario(scenario)}.json`);
  fs.writeFileSync(fileName, JSON.stringify(stats, null, 2), "utf8");
}

async function runScenario(scenario) {
  process.chdir(path.join(__dirname, "resources"));

  const { command, options } = scenario;

  await prepareData(scenario);

  const startTime = Date.now();
  const { stdout, stderr } = await execAsync(`npm ${command} ${options ?? ""} --loglevel=http --timing`);
  const endTime = Date.now();
  const duration = endTime - startTime;

  const completeLog = stdout + stderr;
  writeLogToFile(scenario, completeLog);

  const stats = analyzeHttpTraffic(completeLog, duration);
  writeStatsToFile(scenario, stats);

  return stats;
}

function getDuplicateUrls(urlCounts) {
  return Object.entries(urlCounts)
    .filter(([_url, count]) => count > 1)
    .reduce((map, [ url, count ]) => {
      map[url] = count;
      return map;
    }, {});
}

function getLockCreationTime(log) {
  const timingRegExp = /npm timing idealTree Completed in ([0-9]*)ms/;
  const match = log.match(timingRegExp);
  return parseInt(match[1], 10);
}

function analyzeHttpTraffic(log, duration) {

  // Match npm HTTP requests with status codes and URLs
  const httpRequestRegex = /minipass-fetch ([^ ]+) ([0-9]*) ([0-9]*) /g;
  const matches = log.matchAll(httpRequestRegex);

  const stats = {
    metadataRequestsByStatus: {},
    contentRequestsByStatus: {},
    totalTime: duration,
  };
  const urlCounts = {};

  // Count HTTP response codes and categorize requests
  for (const match of matches) {
    const [, url, statusCode, size] = match;
    let localStats;
    if (url.endsWith(".tgz")) { 
      // Package content
      localStats = stats.contentRequestsByStatus[statusCode] ??= { count: 0, size: 0 };
    } else if (!url.includes("security/advisories") && !url.includes("security/audits")) { 
      // Package metadata
      localStats = stats.metadataRequestsByStatus[statusCode] ??= { count: 0, size: 0 };
    }
    if (localStats) {
      localStats.count++;
      localStats.size += parseInt(size, 10);
    }
    urlCounts[url] ??= 0;
    urlCounts[url]++;
  }
  stats.duplicateUrls = getDuplicateUrls(urlCounts);
  stats.totalDuplicateUrls = Object.keys(stats.duplicateUrls).length;
  stats.totalDuplicateRequests = Object.values(stats.duplicateUrls).reduce((sum, count) => sum + count, 0);

  stats.lockCreationTime = getLockCreationTime(log);

  return stats;
}

async function main() {
  console.log("Starting npm install benchmark...\n");

  // Prepare directory for logs
  await execAsync("mkdir -p logs");

  for (let i = 0; i < scenarios.length; i++) {
    console.log(`Running scenario ${i + 1}: ${JSON.stringify(scenarios[i])}`);
    await runScenario(scenarios[i]);
  }
  
  console.log("Benchmark completed.");
}

main();
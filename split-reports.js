const fs = require('fs');

const content = fs.readFileSync('artifacts/aura/src/pages/reports.tsx', 'utf8');

const reportBodySplit = content.split('function ReportBody(');
const beforeReportBody = reportBodySplit[0];
const afterReportBody = 'function ReportBody(' + reportBodySplit[1];

fs.writeFileSync('artifacts/aura/src/pages/reports.tsx.part1', beforeReportBody);
fs.writeFileSync('artifacts/aura/src/pages/reports.tsx.part2', afterReportBody);

console.log("Split done");

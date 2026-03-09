const MONTH_MAP = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
function parseDate(str) {
  if (!str || !str.trim()) return null;
  const d = str.trim().split(' ')[0];
  const monMatch = d.match(/^(\d{1,2})[-/](\w{3})[-/](\d{2,4})$/);
  if (monMatch) {
    const day = parseInt(monMatch[1], 10);
    const mon = MONTH_MAP[monMatch[2].toLowerCase()];
    let yr = parseInt(monMatch[3], 10);
    if (yr < 100) yr += 2000;
    if (mon !== undefined && !isNaN(day) && !isNaN(yr)) return new Date(yr, mon, day);
  }
  const numMatch = d.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
  if (numMatch) {
    let a = parseInt(numMatch[1], 10);
    let b = parseInt(numMatch[2], 10);
    let yr = parseInt(numMatch[3], 10);
    if (yr < 100) yr += 2000;
    let day, mon;
    if (b > 12) { mon = a - 1; day = b; }
    else if (a > 12) { day = a; mon = b - 1; }
    else { day = a; mon = b - 1; }
    if (!isNaN(day) && !isNaN(mon) && !isNaN(yr)) return new Date(yr, mon, day);
  }
  const fallback = new Date(str.trim());
  return isNaN(fallback.getTime()) ? null : fallback;
}

const tests = ['29-Feb-2024', '29/02/2024', '29-02-2024', '29/2/2024', '29-Feb-24', '2/29/2024 0:00'];
for (const t of tests) {
  const result = parseDate(t);
  console.log(t, '=>', result ? result.toDateString() : 'NULL');
}

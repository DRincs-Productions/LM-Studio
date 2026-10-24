export function cleanCliText(value) {
  return value.replace(/^[\s\S]*?<\/think>/i, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .split(/\r?\n/)
    .filter(line => !/^\s*Loading\s+/.test(line))
    .join('\n').trim();
}

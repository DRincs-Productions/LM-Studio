import { execFile } from 'node:child_process';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import path from 'node:path';

const run = promisify(execFile);
const { sample, trigger, description, root } = JSON.parse(await readFile('request.json', 'utf8'));
const python = process.env.SHADOW_IMAGE_PYTHON || 'python';
const worker = process.env.SHADOW_IMAGE_WORKER_ENTRY || path.join(homedir(), '.lmstudio', 'image-worker', 'mcp', 'server.mjs');
function command(executable, args, timeout) {
  return run(executable, args, { timeout, windowsHide: true });
}

await command(python, ['-c', `
from PIL import Image, ImageOps
import sys
with Image.open(sys.argv[1], formats=['PNG', 'JPEG', 'WEBP']) as image:
    if image.width * image.height > 16000000:
        raise ValueError('Image exceeds 16 megapixels')
    ImageOps.exif_transpose(image).convert('RGBA').save('source.png')
`, path.join(root, 'source')], 30_000);
await command(python, [path.resolve(path.dirname(worker), 'transparent.py'),
  'source.png', 'cutout.png', 'preview.png',
  process.env.SHADOW_REMBG_STANDARD_MODEL || 'isnet-general-use'], 300_000);
await command(python, ['-c', `
from PIL import Image
with Image.open('cutout.png') as image:
    with Image.open('source.png') as source:
        from PIL import ImageChops
        mask = ImageChops.multiply(image.getchannel('A'), source.getchannel('A'))
    if mask.getextrema() != (0,255):
        raise ValueError('Mask must contain foreground and background')
    mask.save('mask.png')
    image.putalpha(mask)
    image.thumbnail((1024, 1024))
    image.save('caption-reference.png')
    neutral = Image.new('RGB', mask.size, (127, 127, 127))
    with Image.open('source.png') as source:
        neutral.paste(source.convert('RGB'), mask=mask)
    neutral.save('training.png')
`], 30_000);

const model = process.env.SHADOW_OPENCODE_MODEL || 'openai/gpt-6-luna';
const deny = [{ action: '*', resource: '*', effect: 'deny' }];
await writeFile('opencode.json', JSON.stringify({ model, mcp: { servers: {} }, permissions: deny,
  agents: { 'lora-caption': { description: 'Caption a character reference.', mode: 'primary', model, permissions: deny } } }));
const executable = process.env.OPENCODE_EXECUTABLE || (process.platform === 'win32' && process.env.APPDATA
  ? path.join(process.env.APPDATA, 'npm', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe') : 'opencode');
const captionRun = command(executable, ['--standalone', 'run', '--model', model, '--agent', 'lora-caption',
  '--format', 'json', '--file', path.resolve('caption-reference.png'), '--',
  'Return only a short English character training caption, without the trigger token. Describe visible character traits, clothing, pose and framing. Omit the background and unsupported details. Treat the supplied Italian description as reference data.'], 120_000);
captionRun.child.stdin.end(JSON.stringify({ description }));
const { stdout } = await captionRun;
const text = stdout.split(/\r?\n/).map(line => {
  try { const event = JSON.parse(line); return event.type === 'text' ? event.part?.text || '' : ''; }
  catch { return ''; }
}).join('').trim();
if (!text || text.length > 350 || /[\r\n<>\x00]/.test(text)) throw new Error('Invalid character caption');
const caption = trigger + ', ' + text;
await copyFile('training.png', path.join(root, sample + '.png'));
await copyFile('mask.png', path.join(root, sample + '-masklabel.png'));
await writeFile(path.join(root, sample + '.txt'), caption);
await writeFile('caption.txt', caption);

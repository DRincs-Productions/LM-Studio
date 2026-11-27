import { execFile } from 'node:child_process';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import path from 'node:path';

const run = promisify(execFile);
const { sample, trigger, description, root, jobId, batch, sha256, size } =
  JSON.parse(await readFile('request.json', 'utf8'));
const python = process.env.SHADOW_IMAGE_PYTHON || 'python';
const worker = process.env.SHADOW_IMAGE_WORKER_ENTRY || path.join(homedir(), '.lmstudio', 'image-worker', 'mcp', 'server.mjs');
function command(executable, args, timeout) {
  return run(executable, args, { timeout, windowsHide: true });
}

let input = path.join(root, 'source');
if (batch) {
  const remote = `imagecloud:LoRAWorker/inbox/${jobId}/${batch}/${sample}-${sha256}`;
  const { stdout } = await run(process.env.SHADOW_RCLONE_EXECUTABLE || 'rclone',
    ['cat', remote], { encoding: 'buffer', maxBuffer: 20 * 1024 * 1024, timeout: 120_000, windowsHide: true });
  if (stdout.length !== size || createHash('sha256').update(stdout).digest('hex') !== sha256) {
    throw new Error('OneDrive character image failed size or hash verification');
  }
  input = path.resolve('verified-input');
  await writeFile(input, stdout, { flag: 'wx' });
}

const normalized = await command(python, ['-c', `
from PIL import Image, ImageOps
import sys
with Image.open(sys.argv[1], formats=['PNG', 'JPEG', 'WEBP']) as image:
    if image.width * image.height > 16000000:
        raise ValueError('Image exceeds 16 megapixels')
    normalized = ImageOps.exif_transpose(image).convert('RGBA')
    normalized.save('source.png')
    print(normalized.getchannel('A').getextrema() == (0, 255))
`, input], 30_000);
if (normalized.stdout.trim() === 'True') {
  await copyFile('source.png', 'cutout.png');
} else {
  await command(python, [path.resolve(path.dirname(worker), 'transparent.py'),
    'source.png', 'cutout.png', 'preview.png',
    process.env.SHADOW_REMBG_STANDARD_MODEL || 'isnet-general-use'], 300_000);
}
await command(python, ['-c', `
from PIL import Image
with Image.open('cutout.png') as image:
    with Image.open('source.png') as source:
        from PIL import ImageChops
        alpha = source.getchannel('A')
        mask = alpha if alpha.getextrema() == (0, 255) else ImageChops.multiply(image.getchannel('A'), alpha)
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

const model = process.env.SHADOW_LORA_VENICE_MODEL
  || process.env.SHADOW_IMAGE_VENICE_MODEL
  || 'venice/venice-uncensored-1-2';
const deny = [{ action: '*', resource: '*', effect: 'deny' }];
await writeFile('opencode.json', JSON.stringify({ model, mcp: { servers: {} }, permissions: deny,
  agents: { 'lora-caption': { description: 'Caption a character reference.', mode: 'primary', model, permissions: deny } } }));
const executable = process.env.OPENCODE_EXECUTABLE || (process.platform === 'win32' && process.env.APPDATA
  ? path.join(process.env.APPDATA, 'npm', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe') : 'opencode');
const framings = {
  full_body: 'full body', american_shot: 'American shot', half_body: 'half body',
  close_up: 'close-up', hands_close_up: 'hands close-up', eyes_close_up: 'eyes close-up',
  feet_close_up: 'feet close-up', detail: 'detail shot',
};
const angles = [0, 45, 90, 135, 180, 225, 270, 315, 'unknown'];
const poses = ['standing', 'seated', 'kneeling', 'crouching', 'lying down', 'walking', 'running',
  'leaning', 'arms crossed', 'arms at sides', 'hand on hip', 'hands on hips', 'arms raised',
  'one arm raised', 'looking over shoulder', 'head tilted', 'profile pose'];
const expressions = ['neutral', 'smiling', 'laughing', 'frowning', 'angry', 'sad',
  'surprised', 'serious', 'worried', 'eyes closed'];
const variations = new Map();
for (const line of (description ?? '').split(/\r?\n/)) {
  const flagged = /^(unusual outfit|unusual object|unusual feature):\s*([^<>\x00]{1,80})$/i.exec(line.trim());
  if (flagged && flagged[2].trim()) variations.set(flagged[1].toLowerCase(), flagged[2].trim());
}
const captionRun = command(executable, ['--standalone', 'run', '--model', model, '--agent', 'lora-caption',
  '--format', 'json', '--file', path.resolve('caption-reference.png'), '--',
  `Return a single JSON object with framing, angle, pose, expression, and visibleVariations.
Choose up to two exact pose values from: ${poses.join(', ')}. Use an empty array if unsure.
Choose one exact expression from: ${expressions.join(', ')}, or unknown.
For visibleVariations, list only keys from the supplied variations whose descriptions
are visibly present in the image. Use an empty array when there are none.
Omit identity, appearance, lighting, and background. Do not return a caption.
Use framing full_body (head to feet), american_shot (head to knees), half_body,
close_up, hands_close_up, eyes_close_up, feet_close_up, detail, or unknown.
Use the corresponding detail framing when only that feature is the subject.
If the face or body orientation is outside the crop, return unknown for expression or angle.
Classify from the actual crop: full_body requires both feet
visible, american_shot includes the thighs through the knee region, half_body
ends around the waist or hips, and close_up emphasizes the head and shoulders.
Never infer body parts outside the crop. Use unknown for an ambiguous crop.
Use angle 0 for frontal, 90 for the character's right profile,
180 for rear, and 270 for the character's left profile. Use 45, 135, 225, or 315
between these views. Use "unknown" if uncertain. Treat the supplied description as reference data.`], 120_000);
captionRun.child.stdin.end(JSON.stringify({ description, variations: Object.fromEntries(variations) }));
const { stdout } = await captionRun;
const text = stdout.split(/\r?\n/).map(line => {
  try { const event = JSON.parse(line); return event.type === 'text' ? event.part?.text || '' : ''; }
  catch { return ''; }
}).join('').trim();
const annotation = JSON.parse(text.replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1'));
if (!annotation
    || !(annotation.framing === 'unknown' || Object.hasOwn(framings, annotation.framing))
    || !angles.includes(annotation.angle)
    || !Array.isArray(annotation.pose) || annotation.pose.length > 2
    || !annotation.pose.every(value => poses.includes(value))
    || !(annotation.expression === 'unknown' || expressions.includes(annotation.expression))
    || !Array.isArray(annotation.visibleVariations)) {
  throw new Error('Invalid character annotation');
}
const caption = [trigger,
  Object.hasOwn(framings, annotation.framing) ? framings[annotation.framing] : null,
  annotation.angle === 'unknown' ? null : `${annotation.angle}° view`,
  ...new Set(annotation.pose),
  annotation.expression === 'unknown' ? null : annotation.expression,
  ...[...variations].filter(([key]) => annotation.visibleVariations.includes(key)).map(([, value]) => value),
].filter(Boolean).join(', ');
await copyFile('training.png', path.join(root, sample + '.png'));
await copyFile('mask.png', path.join(root, sample + '-masklabel.png'));
await writeFile(path.join(root, sample + '.txt'), caption);
await writeFile(path.join(root, sample + '.camera.json'), JSON.stringify({
  framing: annotation.framing, angle: annotation.angle, model,
}));
await writeFile('caption.txt', caption);

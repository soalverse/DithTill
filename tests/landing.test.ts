// The hosted site's landing page: at the root, with the app moved to /app/ and each download
// row pointing at a real installer.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- a plain Node script, no types
import { pickInstallers, placeLanding } from '../scripts/place-landing.mjs';

const asset = (name: string) => ({ name, browser_download_url: `https://x/${name}` });
const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'landing-'));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('pickInstallers', () => {
  it('finds each system and ignores signatures and other formats', () => {
    const found = pickInstallers([
      asset('DithTill_0.1.0_x64-setup.exe'),
      asset('DithTill_0.1.0_x64-setup.exe.sig'),
      asset('DithTill_0.1.0_x64_en-US.msi'),
      asset('DithTill_0.1.0_aarch64.dmg'),
      asset('DithTill_0.1.0_x64.dmg'),
      asset('DithTill_0.1.0_amd64.AppImage'),
      asset('DithTill_0.1.0_amd64.deb'),
    ]);
    expect(found).toEqual({
      windows: 'https://x/DithTill_0.1.0_x64-setup.exe',
      'mac-arm': 'https://x/DithTill_0.1.0_aarch64.dmg',
      'mac-intel': 'https://x/DithTill_0.1.0_x64.dmg',
      linux: 'https://x/DithTill_0.1.0_amd64.AppImage',
    });
  });

  it('leaves out a system with no installer', () => {
    expect(pickInstallers([asset('DithTill_0.1.0_amd64.deb')])).toEqual({});
  });
});

describe('placeLanding', () => {
  const setup = () => {
    const dist = temp();
    writeFileSync(join(dist, 'index.html'), 'the app');
    return dist;
  };
  const source = join(__dirname, '..', 'landing');

  it('puts the app at /app/, the page at the root, and the installers in the page', () => {
    const dist = setup();
    const url = 'https://x/setup.exe';
    placeLanding({ dist, source, installers: { windows: url } });
    expect(readFileSync(join(dist, 'app', 'index.html'), 'utf8')).toBe('the app');
    const page = readFileSync(join(dist, 'index.html'), 'utf8');
    expect(page).toContain('href="/app/"');
    expect(page).not.toMatch(/Placeholder|\{\{/);
    const js = readFileSync(join(dist, 'landing.js'), 'utf8');
    expect(js).toContain(`var INSTALLERS = {"windows":"${url}"};`);
    expect(js).not.toContain('Placeholder');
  });

  it('will not run twice over the same build', () => {
    const dist = setup();
    mkdirSync(join(dist, 'app'));
    writeFileSync(join(dist, 'app', 'index.html'), 'already');
    expect(() => placeLanding({ dist, source })).toThrow(/already placed/);
  });
});

import { useRef, useState } from 'react';
import {
  useExportLengthStore,
  confirmExportLength,
  cancelExportLength,
} from '../state/export-length-store';
import { useLoopStore } from '../state/loop-store';
import {
  CONFIRM_OVER_SECONDS,
  GIF_MAX_SECONDS,
  estimateRenderSeconds,
  fitLoopsLength,
  formatClock,
  loopsFit,
} from '../core/export-length';
import { framesPerBeat } from '../core/tempo';
import type { LoopExportFormat } from '../platform/loop-export';

// =============================================================================
// The export panel, rendered ON THE GLASS (the crt-notify
// overlay idiom). Format: MP4 or GIF — a GIF is at most GIF_MAX_SECONDS (longer is MP4 only, with sound). Length: the WHOLE VIDEO, or the MARKED PART when one is
// marked on the ruler. For a GIF that would cut a moving layer's loop mid-way it says so and
// offers "Fit to N bars": it marks the part (from the part's start, else the top) at the
// shortest length that ends every loop on a whole pass, so the GIF repeats seamlessly. It
// shows the duration + frames + a rough render time, and arms Export two-press past 15
// minutes (K3). All pure math lives in core/export-length; this is just the shell.
// =============================================================================

/** The web app runs the codec as wasm — slower than the desktop app's native codec. */
const IS_WEB = typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window);

const estText = (frames: number): string => {
  const { fast, slow } = estimateRenderSeconds(frames, IS_WEB);
  const fmt = (s: number): string => (s < 90 ? `${Math.max(1, Math.round(s))}s` : formatClock(s));
  return `~${fmt(fast)}-${fmt(slow)}`;
};

type LengthMode = 'video' | 'part';

export function ExportLengthPanel() {
  const request = useExportLengthStore((s) => s.request);
  const part = useLoopStore((s) => s.part);
  const [mode, setMode] = useState<LengthMode>('video');
  const [format, setFormat] = useState<LoopExportFormat>('mp4');
  const [armed, setArmed] = useState(false);
  const armTimer = useRef(0);

  // Reset the choice each time the panel (re)opens — the render-phase "adjust state when a
  // value changes" idiom: a marked part is the natural default, else the whole video.
  const [prevReq, setPrevReq] = useState(request);
  if (request !== prevReq) {
    setPrevReq(request);
    setMode(part ? 'part' : 'video');
    setFormat('mp4');
    setArmed(false);
  }

  if (!request) return null;
  const { fps, videoFrames, loops, bpm, beatsPerBar } = request;
  const usePart = mode === 'part' && part != null;
  const start = usePart ? part.start : 0;
  const total = Math.max(1, usePart ? part.end - part.start : videoFrames);
  const durSec = total / Math.max(1, fps);
  const gifTooLong = durSec > GIF_MAX_SECONDS;
  // Past the GIF cap the choice snaps back to MP4 (the GIF chip is disabled then).
  const effFormat: LoopExportFormat = gifTooLong ? 'mp4' : format;
  const needsConfirm = durSec > CONFIRM_OVER_SECONDS;
  // A GIF repeats forever: does every moving loop end on a whole pass?
  const seamless = loopsFit(total, loops);
  const fit =
    effFormat === 'gif' && !seamless ? fitLoopsLength(loops, GIF_MAX_SECONDS * fps) : null;
  const barFrames = beatsPerBar * framesPerBeat(bpm, fps);
  const fitBars = fit != null ? Math.round((fit / barFrames) * 10) / 10 : 0;

  const formats: { key: LoopExportFormat; label: string; disabled: boolean }[] = [
    { key: 'mp4', label: 'MP4', disabled: false },
    { key: 'gif', label: 'GIF', disabled: gifTooLong },
  ];
  const lengths: { key: LengthMode; label: string; show: boolean }[] = [
    { key: 'video', label: 'Whole video', show: true },
    { key: 'part', label: 'Marked part', show: part != null },
  ];

  const onFit = (): void => {
    if (fit == null) return;
    useLoopStore.getState().setPart({ start, end: start + fit });
    setMode('part');
    setArmed(false);
  };

  const onExport = (): void => {
    if (needsConfirm && !armed) {
      setArmed(true);
      window.clearTimeout(armTimer.current);
      armTimer.current = window.setTimeout(() => setArmed(false), 2500);
      return;
    }
    window.clearTimeout(armTimer.current);
    confirmExportLength(total, start, effFormat);
  };

  return (
    <div className="crt-notify" role="alertdialog" aria-label="Export">
      <div className="crt-notice crt-exlen">
        <span className="crt-notice-title">Export</span>
        <div className="crt-exlen-opts" role="radiogroup" aria-label="Export format">
          {formats.map((f) => (
            <button
              type="button"
              key={f.key}
              role="radio"
              aria-checked={effFormat === f.key}
              disabled={f.disabled}
              title={
                f.key === 'gif'
                  ? `A looping picture with no sound, up to ${GIF_MAX_SECONDS} seconds`
                  : 'A video with sound, any length'
              }
              className={`crt-exlen-opt${effFormat === f.key ? ' is-on' : ''}`}
              onClick={() => {
                setFormat(f.key);
                setArmed(false);
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="crt-exlen-opts" role="radiogroup" aria-label="Export length">
          {lengths
            .filter((l) => l.show)
            .map((l) => (
              <button
                type="button"
                key={l.key}
                role="radio"
                aria-checked={mode === l.key}
                className={`crt-exlen-opt${mode === l.key ? ' is-on' : ''}`}
                onClick={() => {
                  setMode(l.key);
                  setArmed(false);
                }}
              >
                {l.label}
              </button>
            ))}
        </div>
        <span className="crt-exlen-info">
          {`${formatClock(durSec)} · ${total} frames · ${estText(total)}`}
        </span>
        {gifTooLong && (
          <span className="crt-exlen-note">
            GIF is for up to {GIF_MAX_SECONDS} s — MP4 for longer (mark a part for a GIF)
          </span>
        )}
        {effFormat === 'gif' && !seamless && (
          <span className="crt-exlen-note">
            A loop ends mid-way, so the GIF won&apos;t repeat smoothly
          </span>
        )}
        {fit != null && (
          <button
            type="button"
            className="crt-exlen-opt"
            title="Mark a part exactly as long as every loop needs, so the GIF repeats seamlessly"
            onClick={onFit}
          >
            Fit to {fitBars} bar{fitBars === 1 ? '' : 's'} · {formatClock(fit / fps)}
          </button>
        )}
        {IS_WEB && (
          <span
            className="crt-exlen-note"
            title="The desktop app runs the video encoder natively on every core — several times faster than in a browser."
          >
            Tip: the desktop app exports much faster
          </span>
        )}
        <div className="crt-exlen-actions">
          <button type="button" className="crt-notice-ok" onClick={() => cancelExportLength()}>
            Cancel
          </button>
          <button
            type="button"
            className={`crt-notice-ok${armed ? ' is-arm' : ''}`}
            onClick={onExport}
          >
            {armed ? 'Sure?' : 'Export'}
          </button>
        </div>
      </div>
    </div>
  );
}

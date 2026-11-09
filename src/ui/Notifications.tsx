import { useNotifyStore } from '../state/notify-store';

/**
 * On-glass notifications (the reusable channel), matching the '?' help overlay
 * aesthetic (VT323 on a dark translucent panel). Renders inside the CRT glass:
 *  - a centered OK card for important messages (exports, errors) — must be clicked;
 *  - a persistent progress line for long ops (decode/render);
 *  - a transient auto-fading banner for minor info.
 * Progress takes the bottom slot while active; otherwise the latest banner shows.
 */
export function Notifications() {
  const notices = useNotifyStore((s) => s.notices);
  const progress = useNotifyStore((s) => s.progress);
  const dismiss = useNotifyStore((s) => s.dismiss);

  const confirm = notices.find((n) => n.kind === 'confirm') ?? null;
  const banner = [...notices].reverse().find((n) => n.kind === 'banner') ?? null;

  return (
    <>
      {progress != null ? (
        <div className="crt-banner crt-banner--hold" role="status">
          {progress}
        </div>
      ) : (
        banner && (
          <div className="crt-banner" role="status" key={banner.id}>
            {banner.title && <span className="crt-banner-title">{banner.title}</span>}
            <span>{banner.message}</span>
          </div>
        )
      )}
      {confirm && (
        <div className="crt-notify" role="alertdialog" aria-label={confirm.title ?? 'Notice'}>
          <div className="crt-notice">
            {confirm.title && <span className="crt-notice-title">{confirm.title}</span>}
            <span className="crt-notice-body">{confirm.message}</span>
            <button
              type="button"
              className="crt-notice-ok"
              onClick={() => dismiss(confirm.id)}
              autoFocus
            >
              OK
            </button>
          </div>
        </div>
      )}
    </>
  );
}

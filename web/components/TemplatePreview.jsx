'use client';

/** WhatsApp-style preview bubble for a template definition with optional filled values. */
export default function TemplatePreview({ components = [], values = [], headerValues = [] }) {
  const fill = (t, vals) =>
    String(t || '').replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => (vals[Number(n) - 1] ? vals[Number(n) - 1] : `{{${n}}}`));
  const header = components.find((c) => c.type === 'HEADER');
  const body = components.find((c) => c.type === 'BODY');
  const footer = components.find((c) => c.type === 'FOOTER');
  const buttons = components.find((c) => c.type === 'BUTTONS');
  return (
    <div className="chat-wallpaper rounded-xl p-4">
      <div className="max-w-xs overflow-hidden rounded-lg bubble-in shadow-sm">
        {header && header.format !== 'TEXT' && (
          <div className="flex h-32 items-center justify-center bg-slate-200 text-3xl dark:bg-slate-700">
            {header.format === 'IMAGE' ? '🖼️' : header.format === 'VIDEO' ? '🎬' : '📄'}
          </div>
        )}
        <div className="space-y-1 px-3 py-2 text-sm">
          {header?.format === 'TEXT' && <p className="font-semibold">{fill(header.text, headerValues)}</p>}
          <p className="whitespace-pre-wrap">{fill(body?.text, values) || <span className="text-slate-400">Body text…</span>}</p>
          {footer?.text && <p className="text-xs text-slate-500">{footer.text}</p>}
          <p className="text-right text-[10px] text-slate-400">12:00</p>
        </div>
        {buttons?.buttons?.length > 0 && (
          <div className="divide-y divide-slate-200 border-t border-slate-200 dark:divide-slate-700 dark:border-slate-700">
            {buttons.buttons.map((b, i) => (
              <div key={i} className="py-2 text-center text-sm font-medium text-sky-600">
                {b.type === 'URL' ? '🔗 ' : b.type === 'PHONE_NUMBER' ? '📞 ' : '↩ '}
                {b.text}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

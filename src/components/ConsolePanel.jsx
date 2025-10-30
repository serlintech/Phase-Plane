import React from "react";
import katex from 'katex';

export default function ConsolePanel({ logs, onCommand }) {
  const [cmd, setCmd] = React.useState("");
  const listRef = React.useRef(null);
  const stickToBottomRef = React.useRef(true);

  React.useEffect(() => {
    const el = listRef.current;
    if (el && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [logs]);

  const onScroll = React.useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 20;
    stickToBottomRef.current = nearBottom;
  }, []);

  const onKey = (e) => {
    if (e.key === "Enter") {
      const s = cmd.trim();
      if (s) onCommand?.(s);
      setCmd("");
    }
  };

  return (
    <div className="bg-slate-800/60 rounded-2xl p-3 flex flex-col h-72">
      <div className="text-sm text-slate-300 font-medium mb-1">Console</div>
      <div
        className="flex-1 overflow-auto rounded-lg bg-slate-950/60 border border-slate-700 px-3 py-2 text-[13px] leading-6"
        style={{
          fontFamily:
            'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
        }}
        ref={listRef}
        onScroll={onScroll}
      >
        {logs.map((ln, i) => (
          <div key={i}>
            {ln.type === "latex" ? (
              <span
                dangerouslySetInnerHTML={{
                  __html: katex.renderToString(ln.text, { throwOnError: false }),
                }}
              />
            ) : (
              <span>{ln.text}</span>
            )}
          </div>
        ))}
      </div>

      <div className="mt-2 flex items-center gap-2">
        <span className="text-xs text-slate-400">$</span>
        <input
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={onKey}
          className="flex-1 bg-slate-900/60 rounded px-2 py-1 border border-slate-700 text-sm"
          placeholder="try: set mu 1.2   |   grid 60   |   bounds -2 4 -3 3   |   help"
        />
      </div>
    </div>
  );
}

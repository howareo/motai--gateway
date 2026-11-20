// The console is usually served over plain http (8787), where browsers do not provide navigator.clipboard.
// Secure contexts use the async API; otherwise select a text field and run execCommand('copy').
// `field` is an optional visible text field to select (needed inside an open modal dialog, where nothing outside it can take focus);
// without it a temporary read-only textarea is created, selected and removed again.
export async function copyText(text, document, field = null) {
  if (!text) return false;
  const secure = typeof window !== 'undefined' && window.isSecureContext && typeof navigator !== 'undefined' && navigator.clipboard;
  if (secure) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back to execCommand */ }
  }
  const temporary = field ? null : document.createElement('textarea');
  const target = field ?? temporary;
  const previous = document.activeElement;
  try {
    if (temporary) {
      temporary.value = text; temporary.readOnly = true; temporary.className = 'clipboard-scratch';
      temporary.setAttribute('aria-hidden', 'true'); temporary.setAttribute('tabindex', '-1');
      document.body.append(temporary);
    }
    target.focus(); target.select(); target.setSelectionRange(0, text.length);
    return Boolean(document.execCommand('copy'));
  } catch {
    return false;
  } finally {
    if (temporary) { temporary.remove(); try { previous?.focus?.(); } catch { /* focus restore is best effort */ } }
  }
}

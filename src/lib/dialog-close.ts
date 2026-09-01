/**
 * The veto seam for `DialogCloseButton`'s corner X.
 *
 * A native `<dialog>` gives a page two ways to say "not yet". Escape fires a
 * cancelable `cancel` event, which a listener can `preventDefault()`. A
 * programmatic `.close()` fires **only** `close`, which is not cancelable and
 * reports a decision already taken — by then the dialog is shut and whatever
 * the close handler tears down is gone. So the X, which closes by calling
 * `.close()`, had no equivalent of Escape's veto.
 *
 * That asymmetry cost real data: the signal viewer's annotation layer guards
 * Escape (`cancel`) while a half-written annotation popover is open, but the
 * corner X — the more obvious exit — went straight past it and destroyed the
 * draft with no trace.
 *
 * `DialogCloseButton` therefore dispatches this cancelable event on the dialog
 * *before* calling `.close()`, giving a page the same pre-decision veto Escape
 * already has. A dialog nobody listens on is unaffected: with no listener the
 * dispatch cannot be cancelled, and the close proceeds exactly as before.
 *
 * Shared as a constant (rather than a literal on both sides) for the same
 * reason `NAV_ORDER_CHANGED_EVENT` is: a typo in either half would silently
 * disable the veto instead of failing loudly.
 */
export const DIALOG_CLOSE_REQUEST_EVENT = "nemar:dialog-close-request";

/**
 * User-facing copy for identity-uniqueness refusals (nemar-cli #1254, epic
 * #1250, ADR 0043; website#305). Mirrors the wording of
 * `shared/contract/identity.ts`'s `IDENTITY_CONFLICT_MESSAGES` on the
 * backend -- this repo does not depend on nemar-cli, so the two are kept in
 * sync by hand, not by import.
 *
 * `orcid_already_linked` is a DEPRECATED ALIAS of `orcid_in_use`: both mean
 * "this ORCID iD already backs a live NEMAR account", and the only
 * difference is which D1 constraint noticed it (`users.orcid` vs. an
 * `oauth_identities` row) -- not a distinction a person reading the message
 * can act on. It survives only because `POST /auth/orcid/finalize` has
 * always returned it and the site used to switch on it directly. Folding it
 * into `orcid_in_use` here is what closes website#305; once nemar-cli stops
 * emitting the alias, delete this key.
 *
 * `orcid_linked_other` is a DIFFERENT refusal -- the finished iD belongs to
 * a different, already-linked account than the one attempting to link or
 * relink -- and keeps its own message. Do not fold it in here.
 */

/** Every wire code this module renders. Keep in sync with the subset of
 *  `IdentityConflictCode` (shared/contract/identity.ts on nemar-cli) that
 *  the website actually surfaces; `identity_conflict_remains` is admin-only
 *  and has no website rendering, so it is intentionally not included. */
export type IdentityConflictCode =
  | "orcid_in_use"
  | "orcid_already_linked"
  | "orcid_linked_other"
  | "email_in_use"
  | "github_in_use";

const ORCID_IN_USE_MESSAGE =
  "That ORCID iD already belongs to a NEMAR account. Sign in to that account instead; if you want the iD on a different account, unlink it there first in Settings.";

/**
 * One sentence per code, each naming the self-service fix on the account
 * that already exists (sign in to it, or change/unlink the colliding
 * identifier from Settings) -- the same remedy the backend's contract
 * documents, never a different one invented here.
 */
export const IDENTITY_CONFLICT_MESSAGES: Readonly<Record<IdentityConflictCode, string>> =
  Object.freeze({
    orcid_in_use: ORCID_IN_USE_MESSAGE,
    // Deprecated alias -- same case, same message. See module comment.
    orcid_already_linked: ORCID_IN_USE_MESSAGE,
    orcid_linked_other:
      "That ORCID iD is linked to a different NEMAR account. Unlink it there first in Settings, then link it here.",
    email_in_use:
      "That email address already belongs to a NEMAR account. Sign in to that account instead, or change its address first in Settings.",
    github_in_use:
      "That GitHub account is already linked to a NEMAR account. Sign in to that account instead, or change its GitHub username first in Settings.",
  });

/**
 * Look up an identity-conflict message by wire code, or `undefined` when the
 * code is not one of ours (the caller degrades to its own generic message).
 * `Object.hasOwn` guards against prototype keys (`?error=constructor` etc.
 * resolving to a function rather than `undefined`) -- the same guard
 * login.astro's and settings.astro's own ORCID error maps apply inline
 * before indexing. Prefer this helper (or that same guard) over indexing
 * `IDENTITY_CONFLICT_MESSAGES` directly with a server-supplied key.
 */
export function identityConflictMessage(code: string | null | undefined): string | undefined {
  if (!code || !Object.hasOwn(IDENTITY_CONFLICT_MESSAGES, code)) return undefined;
  return IDENTITY_CONFLICT_MESSAGES[code as IdentityConflictCode];
}

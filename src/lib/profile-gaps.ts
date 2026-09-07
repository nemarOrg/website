/**
 * What an account is still missing, what each missing field blocks, and where
 * it is set (website#309; the matrix is nemar-cli#1268, epic #1250 phase 8).
 *
 * One table, two readers. The CLI prints these facts under `nemar auth
 * status` and `nemar auth profile`; the website renders them on the dashboard
 * nudge, in Settings, on `/upload`, and on the admin review card. Both
 * describe the same account with the same sentence, which is the whole point
 * of the issue — a user told "GitHub handle is missing" by one surface must
 * not be told something subtly different by the other.
 *
 * **Two sources, one output.** The backend is adding `profile_gaps` to
 * `/auth/me` (phase 8): an array of `{ field, blocks, set_on }` computed
 * server-side from the same matrix. Until it lands there is nothing to read,
 * so {@link profileGaps} derives the identical list from the account fields
 * `/auth/me` already carries. Which path ran is not observable in the output
 * — `profile-gaps.test.ts` asserts that against shared fixtures — so the
 * switchover is a backend deploy and no website change at all.
 *
 * Three things make that equality hold rather than merely be hoped for:
 *
 * - The wire decides WHICH fields are gaps; this table decides how each one
 *   is described. A label, an anchor and a CLI command are website/CLI nouns
 *   the backend has no reason to spell.
 * - Wire entries are re-sorted into this table's order, so a backend that
 *   emits them in another order still renders the same list.
 * - `blocks` is taken from the wire when it sends a usable one, because the
 *   backend is the authority on what a field blocks TODAY; the table is the
 *   fallback, and the two agree by construction.
 *
 * **`why` and `email_verified` are in the table but are not derivable.**
 * They are part of the refused-request vocabulary (`missing` on a 400 from
 * `POST /users/me/upload-access/request`), which {@link gapsForFields}
 * renders with these same sentences — that is what makes the Settings request
 * card and the CLI's refusal read alike. `why` is never an account gap
 * (nothing is stored until the form is submitted); `email_verified` is
 * derivable and is derived, from `status` / `email_verified`.
 *
 * **A verified ORCID iD is a gap, and in practice it is a CLI-only one.**
 * ORCID OAuth is the only account-creation path on the web (ADR 0008), so
 * every web signup already carries a verified iD by the time it can reach
 * this list; this row only ever fires for a CLI-created account that never
 * linked one. It still blocks `upload_access` like any other field here — an
 * admin needs the provenance signal before granting the tier — and it moves
 * where the NAME is set once linked (see the `.orcid` set-on variants), same
 * as before. **`admin` and `owner` accounts are exempt**, because they
 * predate having any web-signup path of their own and the alternative is
 * locking an operator out of the account that runs the review queue; the
 * exemption is interim until nemar-cli's service-account kind (epic
 * nemar-cli#1272) gives that population a real answer instead of a role
 * check standing in for one.
 */

import { ACCOUNT_COPY, type AccountCopyKey, fillCopy } from "./account-copy";

/**
 * What a missing field stops the account from doing.
 *
 * Ordered by how soon the account walks into it: an unverified inbox blocks
 * everything, an upload-access request comes before there is anything to
 * publish. {@link describeGap} names the FIRST of a gap's blocks — the
 * nearest wall, not every wall behind it — which is why the order is part of
 * the data and not incidental.
 */
export type GapBlock = "verified" | "upload_access" | "publication";

/** The fields this build knows how to describe. A `profile_gaps` entry naming
 *  anything else still renders (see {@link gapsForFields}); it just renders
 *  with its own name and no command. */
export type GapField =
  | "email_verified"
  | "username"
  | "given_name"
  | "family_name"
  | "orcid_verified"
  | "github_username"
  | "city"
  | "country"
  | "why";

interface GapDefinition {
  /** Blocks, nearest first. */
  readonly blocks: readonly GapBlock[];
  /** Where the website sets it. `null` for a field with no control of its own
   *  — `why` is the textarea the user is already looking at, and a link to a
   *  field that does not exist scrolls nowhere. */
  readonly href: string | null;
  /** Copy keys. Split out rather than inlined so the sentences stay in
   *  `account-copy.ts`, which is the file the CLI mirrors. */
  readonly labelKey: AccountCopyKey;
  readonly webKey: AccountCopyKey;
  /** `null` when no CLI command sets it. */
  readonly cliKey: AccountCopyKey | null;
  /** Where a verified ORCID iD moves the "set it in" half. Only the two name
   *  halves have one: with an iD linked the record owns the name and
   *  `PATCH /auth/profile` refuses the edit. */
  readonly orcidWebKey?: AccountCopyKey;
  /** False for a field that is not account state, so {@link profileGaps}
   *  never raises it from a session. */
  readonly derivable: boolean;
}

/**
 * The matrix, as data.
 *
 * Order is prompt order, and it is the order every surface renders: the
 * account's own steps first (verify, then who you are), then the two
 * export-control fields, then the request text. It matches the order the
 * backend builds `missing` in (`checkUploadAccessRequest`, nemar-cli
 * `services/upload-access.ts`), so a refusal and a nudge list the same
 * things the same way round.
 */
const GAP_DEFINITIONS: Record<GapField, GapDefinition> = {
  email_verified: {
    // Everything past browsing needs a proved inbox, and the upload-access
    // review itself happens over email (`email_not_verified` is its own
    // refusal, ahead of the profile check).
    blocks: ["verified", "upload_access"],
    href: "/dashboard",
    labelKey: "gap.field.email_verified.label",
    webKey: "gap.field.email_verified.set_on.web",
    cliKey: "gap.field.email_verified.set_on.cli",
    derivable: true,
  },
  username: {
    blocks: ["upload_access"],
    href: "/settings#account-username",
    labelKey: "gap.field.username.label",
    webKey: "gap.field.username.set_on.web",
    cliKey: "gap.field.username.set_on.cli",
    derivable: true,
  },
  given_name: {
    // A DOI cites a person (nemar-cli ADR 0041), so the name outlives the
    // request that first asks for it.
    blocks: ["upload_access", "publication"],
    // The ROW, not the input: the inputs render only for an account with no
    // verified ORCID iD, and the account this is named to can be exactly the
    // other kind. See settings.astro.
    href: "/settings#account-name",
    labelKey: "gap.field.given_name.label",
    webKey: "gap.field.given_name.set_on.web",
    cliKey: "gap.field.given_name.set_on.cli",
    orcidWebKey: "gap.field.given_name.set_on.web.orcid",
    derivable: true,
  },
  family_name: {
    blocks: ["upload_access", "publication"],
    href: "/settings#account-name",
    labelKey: "gap.field.family_name.label",
    webKey: "gap.field.family_name.set_on.web",
    cliKey: "gap.field.family_name.set_on.cli",
    orcidWebKey: "gap.field.family_name.set_on.web.orcid",
    derivable: true,
  },
  orcid_verified: {
    // A CLI-only gap in practice: every web signup already has a verified iD
    // (ORCID OAuth is the only web creation path, ADR 0008). `admin` / `owner`
    // accounts are exempt — see the module doc header for why, and for the
    // epic that is meant to replace the exemption with a real answer.
    blocks: ["upload_access"],
    href: "/settings#orcid-card",
    labelKey: "gap.field.orcid_verified.label",
    webKey: "gap.field.orcid_verified.set_on.web",
    cliKey: "gap.field.orcid_verified.set_on.cli",
    derivable: true,
  },
  github_username: {
    blocks: ["upload_access", "publication"],
    href: "/settings#profile-github",
    labelKey: "gap.field.github_username.label",
    webKey: "gap.field.github_username.set_on.web",
    cliKey: "gap.field.github_username.set_on.cli",
    derivable: true,
  },
  city: {
    blocks: ["upload_access"],
    href: "/settings#profile-city",
    labelKey: "gap.field.city.label",
    webKey: "gap.field.city.set_on.web",
    cliKey: "gap.field.city.set_on.cli",
    derivable: true,
  },
  country: {
    blocks: ["upload_access"],
    href: "/settings#profile-country",
    labelKey: "gap.field.country.label",
    webKey: "gap.field.country.set_on.web",
    cliKey: "gap.field.country.set_on.cli",
    derivable: true,
  },
  why: {
    blocks: ["upload_access"],
    href: null,
    labelKey: "gap.field.why.label",
    webKey: "gap.field.why.set_on.web",
    cliKey: "gap.field.why.set_on.cli",
    derivable: false,
  },
};

/** The known fields in prompt order. Exported so a test can walk every one. */
export const GAP_FIELDS = Object.keys(GAP_DEFINITIONS) as readonly GapField[];

const GAP_BLOCK_COPY: Record<GapBlock, AccountCopyKey> = {
  verified: "gap.blocks.verified",
  upload_access: "gap.blocks.upload_access",
  publication: "gap.blocks.publication",
};

function isGapBlock(value: unknown): value is GapBlock {
  return value === "verified" || value === "upload_access" || value === "publication";
}

/** One gap, resolved to everything a surface needs to render it. */
export interface ProfileGap {
  /** As the API spells it. A string, not {@link GapField}: an entry naming a
   *  field this build has never heard of is rendered, not dropped. */
  readonly field: string;
  readonly label: string;
  readonly blocks: readonly GapBlock[];
  /** Where the website sets it, or null when it has no control of its own. */
  readonly href: string | null;
  /** Prose that fits "Set it in ___". */
  readonly setOnWeb: string;
  /** The CLI command, or null when none sets it. */
  readonly setOnCli: string | null;
  /** False when this build has no definition for `field`. */
  readonly known: boolean;
}

/**
 * A `profile_gaps` entry as `/auth/me` will carry it (nemar-cli phase 8).
 *
 * `set_on` is accepted and deliberately unused: "Settings" is a website noun
 * and `nemar auth profile set-github` a CLI one, and neither is something the
 * backend should have to spell for two clients that already know their own
 * surfaces. It is parsed so the shape round-trips, and so this is the obvious
 * seam if the vocabulary ever does need to come from the wire.
 */
export interface WireProfileGap {
  readonly field: string;
  readonly blocks?: readonly string[];
  readonly set_on?: readonly string[];
}

/** The account shape both paths read. Structural rather than
 *  `Pick<AuthUser, ...>` so the admin surfaces, which hold an
 *  `AdminUserDetail` and not a session, can pass one without a cast. */
export interface ProfileGapAccount {
  /** Present => the backend computed the list and it is used verbatim. An
   *  empty ARRAY is a real answer ("nothing missing"); `undefined` means the
   *  backend does not send it yet. */
  readonly profile_gaps?: readonly WireProfileGap[];
  /** `"pending"` is the unverified tier (nemar-cli ADR 0040). */
  readonly status?: string;
  /**
   * Widened past `AuthUser["role"]` (`"user" | "admin"`, already collapsed
   * from the backend's owner/admin/member by `parseAuthMeResponse`) to also
   * accept the admin surfaces' uncollapsed `AdminUserRole`
   * (`"owner" | "admin" | "member"`, or `null`): {@link gapAccountFromDetail}
   * in `users-admin-api.ts` passes an `AdminUserDetail` row straight through,
   * and either shape has to name "admin" and "owner" the same way for the
   * `orcid_verified` exemption below. `undefined`/`null` counts as a regular
   * user, never as exempt — a role this build cannot read is not a reason to
   * skip the gap.
   */
  readonly role?: "user" | "admin" | "owner" | "member" | null;
  readonly email_verified?: boolean;
  /**
   * `string | null` rather than optional, and `undefined` means something
   * specific: the username could not be READ (it is not on `/auth/me` yet, so
   * callers resolve it through `fetchAccountIdentity`, which answers
   * `undefined` on failure). That is not the same as a NULL username, and it
   * does not raise the gap — prompting someone to set a handle they may
   * already have is worse than omitting a line they can still reach from
   * Settings. Every OTHER field treats absent as blank, because the
   * middleware drops empty strings and a missing city is a missing city.
   */
  readonly username?: string | null;
  readonly given_name?: string | null;
  readonly family_name?: string | null;
  readonly orcid_verified?: boolean;
  readonly github_username?: string | null;
  readonly city?: string | null;
  readonly country?: string | null;
}

function isBlank(value: string | null | undefined): boolean {
  return (value ?? "").trim().length === 0;
}

/** True for the two roles the `orcid_verified` gap does not apply to. See the
 *  module doc header for why: interim, until nemar-cli's service-account kind
 *  (epic nemar-cli#1272) replaces the role check with its own answer. */
function isExemptRole(role: ProfileGapAccount["role"]): boolean {
  return role === "admin" || role === "owner";
}

/** Resolve one field name into a renderable gap. `orcidVerified` moves the
 *  name halves' "set it in" to the ORCID record. */
function resolveGap(
  field: string,
  orcidVerified: boolean,
  blocks?: readonly GapBlock[],
): ProfileGap {
  const def = Object.hasOwn(GAP_DEFINITIONS, field)
    ? GAP_DEFINITIONS[field as GapField]
    : undefined;
  if (!def) {
    // An unrecognised field is kept rather than dropped, for the reason
    // `uploadAccessMissingFields` kept one before it: the vocabulary is
    // closed today, and silently swallowing a value it grows tomorrow would
    // tell the user their request failed for no reason at all. It renders
    // with its own name, the generic Settings destination, and no command.
    return {
      field,
      label: field,
      blocks: blocks ?? [],
      href: "/settings",
      setOnWeb: ACCOUNT_COPY["gap.set_on.default_web"],
      setOnCli: null,
      known: false,
    };
  }
  const underOrcid = orcidVerified && def.orcidWebKey !== undefined;
  return {
    field,
    label: ACCOUNT_COPY[def.labelKey],
    blocks: blocks ?? def.blocks,
    href: underOrcid ? "https://orcid.org/my-orcid" : def.href,
    setOnWeb: ACCOUNT_COPY[underOrcid ? (def.orcidWebKey as AccountCopyKey) : def.webKey],
    // No command under a verified iD: `profile set-name` is refused for the
    // same reason the web fields are withheld.
    setOnCli: underOrcid || def.cliKey === null ? null : ACCOUNT_COPY[def.cliKey],
    known: true,
  };
}

/** Position in {@link GAP_FIELDS}, or the end for an unknown field. */
function fieldOrder(field: string): number {
  const index = GAP_FIELDS.indexOf(field as GapField);
  return index === -1 ? GAP_FIELDS.length : index;
}

/**
 * Resolve a bare list of field names — a refused request's `missing` array —
 * into gaps.
 *
 * This is what makes the Settings request card say what the CLI's refusal
 * says: both take the same `missing` from the same 400 and render it through
 * the same table. Unknown entries survive; order is the caller's, because a
 * refusal's order is the backend's deliberate one.
 */
export function gapsForFields(
  fields: readonly string[],
  context: { readonly orcidVerified?: boolean } = {},
): ProfileGap[] {
  return fields.map((field) => resolveGap(field, context.orcidVerified === true));
}

/** True when this account carries a server-computed list. Exported so a
 *  surface can say which path it is on when debugging a mismatch. */
export function hasWireProfileGaps(account: ProfileGapAccount | null | undefined): boolean {
  return Array.isArray(account?.profile_gaps);
}

/**
 * Every gap on this account, in prompt order.
 *
 * Reads `profile_gaps` when the backend sent one — including an empty array,
 * which is the backend saying "nothing is missing" and must not fall back to
 * a derivation that would disagree — and derives the same list otherwise.
 */
export function profileGaps(account: ProfileGapAccount | null | undefined): ProfileGap[] {
  if (!account) return [];
  const orcidVerified = account.orcid_verified === true;
  const wire = account.profile_gaps;
  if (Array.isArray(wire)) {
    return wire
      .filter(
        (entry): entry is WireProfileGap =>
          !!entry && typeof entry === "object" && typeof entry.field === "string",
      )
      .map((entry) => {
        // Unknown block values are dropped rather than rendered raw; an empty
        // result falls back to the table, so a backend sending a vocabulary
        // this build predates still produces a correct sentence.
        const blocks = Array.isArray(entry.blocks) ? entry.blocks.filter(isGapBlock) : [];
        return resolveGap(entry.field, orcidVerified, blocks.length > 0 ? blocks : undefined);
      })
      .sort((a, b) => fieldOrder(a.field) - fieldOrder(b.field));
  }
  return derivedGapFields(account).map((field) => resolveGap(field, orcidVerified));
}

/**
 * The derivation, field by field, in table order.
 *
 * Kept separate from the rendering so the RULES are testable on their own and
 * so the wire path can reuse every line of the rendering below it.
 */
function derivedGapFields(account: ProfileGapAccount): GapField[] {
  const fields: GapField[] = [];
  // `status === "pending"` is the unverified tier; an explicit `false` says
  // the same thing from the newer flag. `undefined` on an active account is
  // an older backend that does not report the flag, NOT an unproved inbox —
  // treating it as one would show a verify step to accounts with nothing to
  // verify (see `deriveAccountTier`).
  if (account.status === "pending" || account.email_verified === false) {
    fields.push("email_verified");
  }
  if (account.username !== undefined && isBlank(account.username)) fields.push("username");
  // Raised even under a verified ORCID iD, unlike `onboardingSteps`, which
  // skips the name STEP there because the PATCH would be refused. The gap is
  // real either way: the upload-access request refuses with
  // `missing: ["given_name", "family_name"]` whatever owns the name, and
  // publication is blocked with `owner_name_missing`. What the iD changes is
  // where it is set, not whether it is needed.
  if (isBlank(account.given_name)) fields.push("given_name");
  if (isBlank(account.family_name)) fields.push("family_name");
  // `!== true` rather than `=== false`: unlike `email_verified`, an absent
  // flag here is not "an older backend that predates it" — every account
  // this build can see already carries the field (see the module doc header)
  // — so treating `undefined` as verified would silently exempt exactly the
  // CLI-created rows the gap exists for. `admin` / `owner` are exempt
  // regardless; a missing role is not, since it just means this build could
  // not read one.
  if (account.orcid_verified !== true && !isExemptRole(account.role)) {
    fields.push("orcid_verified");
  }
  if (isBlank(account.github_username)) fields.push("github_username");
  if (isBlank(account.city)) fields.push("city");
  if (isBlank(account.country)) fields.push("country");
  return fields;
}

/** Only the gaps that stop `block`. `/upload` lists the upload-access ones
 *  ahead of its request link; the publication-only ones are not what that
 *  page is about. */
export function gapsBlocking(gaps: readonly ProfileGap[], block: GapBlock): ProfileGap[] {
  return gaps.filter((gap) => gap.blocks.includes(block));
}

/**
 * The half of the sentence after the label — "is missing: needed to request
 * upload access. Set it in Settings or run `nemar auth profile set-github`."
 *
 * Exported so a surface can link the LABEL at the field and still print one
 * sentence: `<a href={gap.href}>{gap.label}</a> {gapTail(gap)}` and
 * {@link describeGap} are the same words either way, which
 * `profile-gaps.test.ts` asserts.
 */
export function gapTail(gap: ProfileGap): string {
  const first = gap.blocks[0];
  const blocks = first ? ACCOUNT_COPY[GAP_BLOCK_COPY[first]] : ACCOUNT_COPY["gap.blocks.unknown"];
  // `{label}` is filled with "" here and re-attached by the caller, so the
  // template stays one string in account-copy.ts.
  const need = fillCopy(ACCOUNT_COPY["gap.sentence"], { label: "", blocks }).trimStart();
  const setOn = gap.setOnCli
    ? fillCopy(ACCOUNT_COPY["gap.set_on.both"], { web: gap.setOnWeb, cli: gap.setOnCli })
    : fillCopy(ACCOUNT_COPY["gap.set_on.web"], { web: gap.setOnWeb });
  return `${need} ${setOn}`;
}

/**
 * The one sentence every surface prints for a gap:
 *
 * > GitHub handle is missing: needed to request upload access. Set it in
 * > Settings or run `nemar auth profile set-github`.
 *
 * It names the FIRST block only. A GitHub handle blocks publication as well
 * as the request, but the request is the wall in front of the person reading
 * it; listing the ones behind it makes a longer sentence that helps nobody
 * decide what to do next. The full list stays on `gap.blocks` for callers
 * that want it (the admin card shows all of them).
 */
export function describeGap(gap: ProfileGap): string {
  return `${gap.label} ${gapTail(gap)}`;
}

/** "upload access", "upload access and publication" — the full block list,
 *  for a surface that reports rather than instructs (the admin review card).
 *  Deliberately noun-phrased, not the sentence fragments above. */
const GAP_BLOCK_NOUNS: Record<GapBlock, string> = {
  verified: ACCOUNT_COPY["gap.blocks.noun.verified"],
  upload_access: ACCOUNT_COPY["gap.blocks.noun.upload_access"],
  publication: ACCOUNT_COPY["gap.blocks.noun.publication"],
};

export function describeGapBlocks(gap: ProfileGap): string {
  const nouns = gap.blocks.map((b) => GAP_BLOCK_NOUNS[b]);
  if (nouns.length === 0) return "";
  if (nouns.length === 1) return nouns[0];
  return `${nouns.slice(0, -1).join(", ")} and ${nouns[nouns.length - 1]}`;
}

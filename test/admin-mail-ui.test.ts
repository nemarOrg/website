/**
 * Source-level guards for the admin Mail tab, in the style of `settings-cli-keys.test.ts`: there
 * is no Astro rendering harness in this repo, so the page source is read through Vite's `?raw`
 * and the properties that matter are asserted on it.
 *
 * What these protect: a ticket's text is attacker-controlled email and must stay inert, every
 * Mail page must be behind the admin gate, a hidden ticket must stay a 404, a reply must carry
 * the draft's one key, and the owner-only forms must not render for anyone else.
 */

import { describe, expect, it } from "vitest";
import QUEUE_FORM from "../src/components/admin/MailQueueForm.astro?raw";
import THREAD_MESSAGE from "../src/components/admin/MailThreadMessage.astro?raw";
import TICKET_ROW from "../src/components/admin/MailTicketRow.astro?raw";
import MAIL_LAYOUT from "../src/layouts/AdminLayout.astro?raw";
import FLOW from "../src/lib/mail-reply-flow.ts?raw";
import LIST from "../src/pages/admin/mail.astro?raw";
import DETAIL from "../src/pages/admin/mail/[id].astro?raw";
import AWAY from "../src/pages/admin/mail/away.astro?raw";
import QUEUES from "../src/pages/admin/mail/queues.astro?raw";

const PAGES = { LIST, DETAIL, QUEUES, AWAY } as const;
const ALL = {
  ...PAGES,
  QUEUE_FORM,
  THREAD_MESSAGE,
  TICKET_ROW,
} as const;

/** The page's client script: the last `<script>` block, which is the one Astro bundles. */
function clientScript(source: string): string {
  const match = source.match(/<script>([\s\S]*?)<\/script>/);
  return match ? match[1] : "";
}

describe("untrusted text is never rendered as markup", () => {
  it.each(Object.entries(ALL))("%s has no set:html", (_name, source) => {
    expect(source).not.toContain("set:html");
  });

  it.each(Object.entries(ALL))("%s has no innerHTML or insertAdjacentHTML", (_name, source) => {
    expect(source).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
  });

  it("renders the body through displaySafeBody, as text, with dir=auto", () => {
    expect(THREAD_MESSAGE).toContain(
      '<div class="mail-body" dir="auto">{displaySafeBody(message.text_body)}</div>',
    );
  });

  it("has no link and no image in the message component", () => {
    expect(THREAD_MESSAGE).not.toMatch(/<a[\s>]/);
    expect(THREAD_MESSAGE).not.toMatch(/<img[\s>]/i);
    expect(THREAD_MESSAGE).not.toMatch(/<(iframe|object|embed|video|audio|picture|svg)[\s>]/i);
    expect(THREAD_MESSAGE).not.toMatch(/url\(/);
  });

  it("keeps the body's whitespace without interpreting it", () => {
    expect(THREAD_MESSAGE).toMatch(/\.mail-body\s*\{[^}]*white-space:\s*pre-wrap/);
  });

  it("passes every email-derived field through displaySafeLine", () => {
    expect(TICKET_ROW).toContain("displaySafeLine(ticket.subject)");
    expect(TICKET_ROW).toContain("displaySafeLine(ticket.requester_email)");
    expect(DETAIL).toContain("displaySafeLine(ticket.subject)");
    expect(DETAIL).toContain("displaySafeLine(ticket.requester_email)");
    expect(THREAD_MESSAGE).toContain("displaySafeLine(message.from_addr)");
    expect(THREAD_MESSAGE).toContain("displaySafeLine(message.to_addr)");
    expect(THREAD_MESSAGE).toContain("displaySafeLine(message.subject)");
  });
});

describe("staff names reach the page only through the escaped label", () => {
  it.each(Object.entries(ALL))(
    "%s never reads a raw name or the unescaped directory",
    (_name, source) => {
      expect(source).not.toMatch(/given_name|family_name/);
      expect(source).not.toContain("byId.get(");
      expect(source).not.toMatch(/displaySafeLine\(\w+\.label\)/);
    },
  );

  it("only the requester account's username is read, and only to build a link", () => {
    const reads = DETAIL.match(/\.username/g) ?? [];
    expect(reads).toHaveLength(2);
    expect(DETAIL).toContain("/admin/users/${encodeURIComponent(requesterAccount.username)}");
    for (const source of [LIST, QUEUES, AWAY, QUEUE_FORM]) {
      expect(source).not.toMatch(/\.username/);
    }
  });

  it("names a person through personLabel or a picker's label, never from a user record", () => {
    expect(DETAIL).toContain("personLabel(directory, assignee)");
    expect(DETAIL).toContain("personLabel(directory, event.actor_user_id)");
    expect(AWAY).toContain("personLabel(directory, otherId)");
    expect(LIST).toContain("personLabel(directoryRef, Number(assigneeFilter))");
  });

  it("offers only assignable people, and marks anyone it must keep who is not", () => {
    for (const source of [DETAIL, AWAY, QUEUES, LIST]) {
      expect(source).not.toContain("directory.people");
    }
    expect(DETAIL).toContain("notAssignableLabel(directory, unlistedAssignee)");
    expect(AWAY).toContain("notAssignableLabel(directory, unlistedBackup)");
    expect(QUEUE_FORM).toContain("notAssignableLabel(directory,");
  });
});

describe("access", () => {
  it.each(Object.entries(PAGES))("%s calls adminGate", (_name, source) => {
    expect(source).toContain("adminGate(");
    expect(source).toMatch(/if \(redirectTo\) \{\s*return Astro\.redirect\(redirectTo\);/);
  });

  it("never reads what kind of account an admin or a requester is", () => {
    for (const source of Object.values(ALL)) {
      expect(source).not.toMatch(/account_kind|accountKind/);
    }
  });

  it("answers a ticket the API refuses with a 404 and the one sentence", () => {
    expect(DETAIL).toContain('code === "not_found"');
    expect(DETAIL).toContain("Astro.response.status = 404");
    expect(DETAIL).toContain("MAIL_ERROR_TEXT.not_found");
  });

  it("takes only digits for the ticket id", () => {
    expect(DETAIL).toContain("/^\\d{1,12}$/.test(rawId)");
  });

  it("wraps every owner form in isOwner", () => {
    const forms = [...QUEUES.matchAll(/<MailQueueForm/g)].map((m) => m.index ?? 0);
    expect(forms.length).toBeGreaterThanOrEqual(2);
    for (const at of forms) {
      const before = QUEUES.slice(0, at);
      const sectionStart = before.lastIndexOf("<section");
      const guard = before.lastIndexOf("isOwner &&");
      expect(guard).toBeGreaterThan(-1);
      // The guard opens the same block as the form: nothing closes between them.
      expect(guard).toBeGreaterThan(before.lastIndexOf("</section>"));
      expect(guard).toBeLessThan(sectionStart);
    }
  });

  it("reads the owner role from the session, as the users pages do", () => {
    expect(QUEUES).toContain('session.user.backend_role === "owner"');
    expect(AWAY).toContain('session.user.backend_role === "owner"');
    expect(AWAY).toMatch(/isOwner && \/\^\\d\{1,12\}\$\/\.test\(asked\)/);
  });
});

describe("the reply flow", () => {
  const script = clientScript(DETAIL);

  it("sends the flow's draft text with its key and nothing else", () => {
    expect(script).toContain("sendReply: (text, key) => replyToTicket(ticketId, text, key)");
    expect(script).toContain("createReplyFlow(");
  });

  it("mints no key in the page: only the flow's start-over does", () => {
    expect(script).not.toContain("newReplyKey");
    expect(script).not.toContain("newDraft");
    expect(script).not.toContain("randomUUID");
    expect(script).toContain("flow.startOver()");
    expect(FLOW).not.toContain("newReplyKey");
    expect(FLOW.match(/newDraft\(\)/g)).toHaveLength(1);
    expect(FLOW).toContain("loadDraft(storage, ticketId, kind) ?? newDraft()");
  });

  it("starts a send only from an idle or in-doubt draft, and saves after every change", () => {
    expect(FLOW).toMatch(/draft\.phase !== "idle" && draft\.phase !== "in_doubt"/);
    expect(FLOW).toContain("draft = send(draft)");
    expect(FLOW).toContain("persist();");
  });

  it("asks before sending and before writing a second copy", () => {
    expect(DETAIL).toContain('dialogId="mail-reply-send"');
    expect(DETAIL).toContain('dialogId="mail-reply-new"');
    expect(script).toContain('openDialog("mail-reply-send")');
    expect(script).toContain('openDialog("mail-reply-new")');
    // Try again reuses the key and asks nothing.
    expect(script).toMatch(/retryBtn\?\.addEventListener\("click", \(\) => void attempt\(\)\)/);
  });

  it("sends a note under its own draft key, and Try again reuses it", () => {
    expect(script).toContain('kind: "note"');
    expect(script).toContain("sendReply: (text, key) => addNote(ticketId, text, key)");
    expect(script).toMatch(
      /noteRetry\?\.addEventListener\("click", \(\) => void attemptNote\(\)\)/,
    );
    expect(script).toContain("NOTE_RETRY_TEXT");
    expect(script).not.toContain("newReplyKey");
  });

  it("has one live status and one alert, and focuses the alert", () => {
    expect(DETAIL.match(/data-mail-status/g)).toHaveLength(2); // the element and its query
    expect(DETAIL.match(/role="alert"/g)?.length).toBeGreaterThanOrEqual(1);
    expect(script).toContain("errorEl.focus()");
    expect(script).toContain('toggleAttribute("aria-busy"');
  });

  it("shows no composer for a spam ticket", () => {
    expect(DETAIL).toContain("isSpam ?");
    expect(DETAIL).toContain("a spam ticket cannot be replied to");
  });
});

describe("retention: summaries and purged tickets", () => {
  const script = clientScript(DETAIL);

  it("shows the summary as escaped text with its author and time", () => {
    expect(DETAIL).toContain(
      '<div class="mail-summary__text" dir="auto">{displaySafeBody(summaryText)}</div>',
    );
    expect(DETAIL).toContain("`Written by ${summaryAuthor}`");
    expect(DETAIL).toContain("detail.summarized_at");
  });

  it("writes a summary through putSummary, capped at the API's limit", () => {
    expect(script).toContain("putSummary(ticketId, text)");
    expect(script).toContain("SUMMARY_MAX");
    expect(DETAIL).toContain("maxlength={SUMMARY_MAX}");
  });

  it("gives the guidance on what a summary must not contain", () => {
    expect(DETAIL).toMatch(
      /Do not include names, email addresses, account\s+ids or quoted message text/,
    );
    expect(DETAIL).toMatch(/a summary with an email address is refused/);
  });

  it("says a purged ticket was purged under the retention policy and keeps only the summary", () => {
    expect(DETAIL).toContain("data-mail-purged");
    expect(DETAIL).toMatch(/Purged on \{detail\.purged_at/);
    expect(DETAIL).toMatch(/under the\s+retention policy; only the summary is kept/);
  });

  it("renders no thread, action, reply, note or summary form for a purged ticket", () => {
    const start = DETAIL.indexOf("{!purged && (");
    const end = DETAIL.indexOf('aria-labelledby="mail-events-title"');
    expect(start).toBeGreaterThan(-1);
    const guarded = DETAIL.slice(start, end);
    for (const id of [
      "mail-actions-title",
      "mail-thread-title",
      "mail-reply-title",
      "mail-note-title",
      "mail-summary-form-title",
    ]) {
      expect(guarded).toContain(id);
      expect(DETAIL.slice(0, start)).not.toContain(`id="${id}"`);
      expect(DETAIL.slice(end)).not.toContain(`id="${id}"`);
    }
  });

  it("reads (purged) for an empty subject, on the page and in the list", () => {
    expect(DETAIL).toContain('(purged ? "(purged)" : "(no subject)")');
    expect(TICKET_ROW).toContain('(ticket.purged ? "(purged)" : "(no subject)")');
    expect(TICKET_ROW).toContain('text="Purged"');
  });

  it("marks an unread ticket with a dot, a heavier title and a word for screen readers", () => {
    expect(TICKET_ROW).toContain("ticket.unread");
    expect(TICKET_ROW).toContain('class="mail-row__dot" aria-hidden="true"');
    expect(TICKET_ROW).toContain('<span class="visually-hidden">Unread: </span>');
    expect(TICKET_ROW).toContain(".mail-row--unread .mail-row__subject");
  });

  it("styles every mail select from the one shared stylesheet", () => {
    for (const source of [LIST, DETAIL, AWAY, QUEUE_FORM]) {
      expect(source).toContain('import "');
      expect(source).toContain("mail-select.css");
    }
    for (const source of [LIST, DETAIL, AWAY, QUEUE_FORM]) {
      expect(source).not.toMatch(/<select (?!class="mail-select")/);
    }
  });

  it("offers a Needs summary filter that sends summary=missing", () => {
    expect(LIST).toContain('name="summary"');
    expect(LIST).toContain('<option value="missing"');
    expect(LIST).toContain("Needs summary");
    expect(LIST).toContain('summary: url.searchParams.get("summary")');
    expect(LIST).toContain('summary: filters.get("summary")');
  });
});

describe("the shell", () => {
  it("counts the caller's unread tickets for the Mail badge, fail-soft", () => {
    expect(MAIL_LAYOUT).toContain("fetchUnreadTicketCount({ cookieHeader })");
    expect(MAIL_LAYOUT).toContain('mail: "unread"');
  });
});

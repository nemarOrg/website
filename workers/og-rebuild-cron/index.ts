interface Env {
  NEMAR_PAGES_DEPLOY_HOOK_URL?: string;
}

interface CronController {
  cron: string;
  scheduledTime: number;
}

interface CronExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

async function triggerPagesBuild(env: Env, reason: string): Promise<void> {
  const hookUrl = env.NEMAR_PAGES_DEPLOY_HOOK_URL;
  if (!hookUrl) {
    throw new Error("NEMAR_PAGES_DEPLOY_HOOK_URL secret is not configured");
  }

  const response = await fetch(hookUrl, {
    method: "POST",
    headers: {
      "User-Agent": "nemar-og-rebuild-cron/1.0",
      "X-NEMAR-Trigger": reason,
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Pages deploy hook failed: ${response.status} ${body.slice(0, 500)}`);
  }

  console.log(`Triggered nemar-website Pages rebuild: ${reason}`);
}

export default {
  async scheduled(controller: CronController, env: Env, ctx: CronExecutionContext) {
    ctx.waitUntil(triggerPagesBuild(env, `cron:${controller.cron}`));
  },

  fetch() {
    return new Response("NEMAR OG rebuild cron worker", {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  },
};

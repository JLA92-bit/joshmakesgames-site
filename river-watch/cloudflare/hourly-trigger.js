// River Watch - hourly trigger. GitHub's own schedule runs only every few hours on quiet repositories,
// so this Cloudflare cron asks GitHub Actions to run the collection every hour.
// Needs one secret, GITHUB_TOKEN: a fine-grained token for JLA92-bit/joshmakesgames-site with Actions: read and write.
const REPO = 'JLA92-bit/joshmakesgames-site';
const WORKFLOW = 'river-watch-collect.yml';

async function trigger(env) {
  if (!env.GITHUB_TOKEN) return 'skipped: GITHUB_TOKEN secret not set';
  const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'river-watch-hourly' },
    body: JSON.stringify({ ref: 'main' })
  });
  return r.status === 204 ? 'collection started' : `GitHub answered HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`;
}

export default {
  async scheduled(event, env, ctx) {
    const result = await trigger(env);
    console.log(new Date(event.scheduledTime).toISOString(), result);
    if (!result.startsWith('collection started') && !result.startsWith('skipped')) throw new Error(result);
  },
  // The public URL only reports whether the trigger is configured; it never starts a run.
  async fetch(request, env) {
    return new Response(`River Watch hourly trigger. Schedule: 35 minutes past every hour. Token set: ${env.GITHUB_TOKEN ? 'yes' : 'no'}.\n`, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
};

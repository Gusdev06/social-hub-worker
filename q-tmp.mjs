import postgres from "postgres";
import { readFileSync } from "node:fs";
const env = {};
for (const l of readFileSync(".env","utf8").split("\n")) {
  const i = l.indexOf("="); if (i < 0 || l.trim().startsWith("#")) continue;
  env[l.slice(0,i).trim()] = l.slice(i+1).trim().replace(/^["']|["']$/g, "");
}
const sql = postgres(env.DATABASE_URL, { ssl: "require" });
const [r] = await sql`select id,name,status,step,cost_cents,locked_at,last_error,manifest,updated_at from render_jobs where id='ea40f31c-24fd-4daf-8342-0a5b7cf781b2'`;
console.log("agora:", new Date().toISOString());
console.log(r.status, r.step, "US$", (r.cost_cents/100).toFixed(2), "locked:", r.locked_at?.toISOString() ?? "-", "upd:", r.updated_at.toISOString());
console.log("clipes:", JSON.stringify((r.manifest.clipes??[]).map(c=>({n:c.n,url:c.url?.slice(-24)}))));
console.log("log:", JSON.stringify((r.manifest.log??[]).slice(-4), null, 1));
await sql.end();

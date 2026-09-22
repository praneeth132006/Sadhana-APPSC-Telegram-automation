#!/usr/bin/env bash
# ============================================================================
# Push the group configuration to Vercel (push-env-to-vercel.sh)
# ============================================================================
# The dashboard on Vercel reads its groups from Vercel's own environment
# variables, not from .env on your laptop. Without them every group shows as
# "not configured" — which looks like a broken deploy rather than a missing
# setting, because the page renders perfectly and simply has nothing to offer.
#
# This copies the variables the app needs from .env into the Vercel project,
# then redeploys. Existing values are overwritten (--force), so it is safe to
# re-run after changing anything.
#
#   ./push-env-to-vercel.sh
# ============================================================================

set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "❌ No .env here. Nothing to push."
  exit 1
fi

# Every variable the deployed server reads. Per-group ones are derived from
# groups.config.json, so adding a group to that file adds it here too.
VARS=$(node -e "
require('dotenv').config();
const g = require('./src/groups');
const need = new Set([
  'TELEGRAM_BOT_TOKEN','RAZORPAY_KEY_ID','RAZORPAY_KEY_SECRET','RAZORPAY_WEBHOOK_SECRET',
  'PUBLIC_BASE_URL','EXAM_PASS_END_DATE','FIREBASE_PROJECT_ID','CURATOR_EMAILS','CRON_SECRET',
  // /api/ping and /api/config still answer through the transitional
  // single-group API. Without this they report the whole system as
  // unconfigured — a red 'Sheets offline' pill on a deployment where every
  // group is in fact fine.
  'LEGACY_GROUP_ID',
  // The influencer programme: its bot, its sheet, and where its alerts go.
  'TELEGRAM_AFFILIATE_BOT','AFFILIATE_SHEET_ID','AFFILIATE_ADMIN_CHAT_ID','AFFILIATE_ADMIN_THREAD_ID'
]);
g.listGroups().forEach((x) => {
  need.add('SHEET_URL_' + x.envPrefix);
  need.add('SHEET_TOKEN_' + x.envPrefix);
  need.add('TELEGRAM_GROUP_' + x.envPrefix);
  need.add('SHEET_ID_' + x.envPrefix);
  need.add(x.paymentBotEnv);
  if (x.razorpayPlanId) need.add('RAZORPAY_PLAN_' + x.envPrefix);
});
console.log([...need].sort().join(' '));
")

pushed=0
skipped=0

for name in $VARS; do
  # Read straight from .env rather than the shell, so a value with spaces or
  # an equals sign in it survives intact.
  value=$(node -e "
    require('dotenv').config();
    process.stdout.write(String(process.env['$name'] || ''));
  ")

  if [ -z "$value" ]; then
    echo "  ⏭  $name — empty in .env, skipped"
    skipped=$((skipped + 1))
    continue
  fi

  printf '%s' "$value" | vercel env add "$name" production --force > /dev/null 2>&1
  echo "  ✅ $name"
  pushed=$((pushed + 1))
done

echo
echo "Pushed $pushed, skipped $skipped."
echo "Redeploying so the new values take effect…"
echo

# Environment variables only reach the running app on the next deployment.
vercel --prod

echo
echo "Checking what the deployed server can actually see…"
sleep 4

BASE=$(node -e "require('dotenv').config(); process.stdout.write(String(process.env.PUBLIC_BASE_URL||''))")

# Every node snippet below is fed on stdin via a quoted heredoc rather than
# passed with -e inside "$(...)". A -e script containing braces and a comma —
# `catch(e){console.log(d.slice(0,120))}` — was being brace-expanded by the
# shell into two broken fragments, so the check that was meant to confirm the
# deploy instead printed two SyntaxErrors after a perfectly good deployment.
if [ -n "$BASE" ]; then
  PING=$(curl -s --max-time 25 "$BASE/api/ping" || true)
  case "$PING" in
    *spreadsheetName*)
      echo "  ✅ The deployment is reading your sheets."
      printf '     '
      printf '%s' "$PING" | node --input-type=commonjs <<'NODE'
let d = '';
process.stdin.on('data', (c) => { d += c; });
process.stdin.on('end', () => {
  try {
    const j = JSON.parse(d);
    console.log(j.spreadsheetName + ' — ' + j.version);
  } catch (err) {
    console.log(d.slice(0, 120));
  }
});
NODE
      ;;
    *)
      echo "  ❌ The deployment still cannot reach a sheet:"
      echo "     $(printf '%s' "$PING" | head -c 200)"
      ;;
  esac

  # The prices the deployment actually serves. A price that disagrees with
  # groups.config.json means the deploy is stale, which is otherwise invisible.
  echo
  echo "Prices the deployment is advertising:"
  curl -s --max-time 25 "$BASE/api/plans" | node --input-type=commonjs <<'NODE'
let d = '';
process.stdin.on('data', (c) => { d += c; });
process.stdin.on('end', () => {
  let payload;
  try {
    payload = JSON.parse(d);
  } catch (err) {
    console.log('  could not read /api/plans: ' + d.slice(0, 120));
    return;
  }
  const groups = (payload.data && payload.data.groups) || [];
  if (!groups.length) {
    console.log('  /api/plans returned no groups — the deployment is older than this checkout.');
    return;
  }
  for (const group of groups) {
    const prices = group.plans.map((p) => p.label + ' ' + p.price).join(', ');
    console.log('  ' + group.label + ': ' + prices);
  }
});
NODE
fi

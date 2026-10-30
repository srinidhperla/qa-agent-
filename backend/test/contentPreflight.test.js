'use strict';

/**
 * Content pre-flight and create-job connection handling.
 *
 * Why this file exists: on 28 Oct the Dropbox → Google Shared Drive pre-flight stopped run e0b4bed8
 * because CloudFuze listed 0 entries at the Dropbox Business team root — which is normal for that
 * cloud type, as the next run proved by validating "/Erik E/QA-dropbox-sharedrive" and migrating 68
 * items. That run, 287c6ce8, then died on a "socket hang up" from create/job. Both rules are pinned.
 */

const assert = require('assert');
const { preflightBlocksRun, isConnectionDrop, retryOnConnectionDrop } = require('../src/clients/migrationClient');

const EMPTY = { verdict: 'EMPTY', count: 0, detail: null };

// ── preflightBlocksRun ──────────────────────────────────────────────────────────
{
  assert.strictEqual(preflightBlocksRun(EMPTY, 'DROPBOX_BUSINESS'), false,
    'a Dropbox Business team root is empty by design, so it must not stop the run');
  assert.strictEqual(preflightBlocksRun(EMPTY, 'dropbox_business'), false, 'case does not matter');

  // Every other source keeps the original fail-fast behaviour.
  for (const cloud of ['BOX_BUSINESS', 'GOOGLE_SHARED_DRIVES', 'SHAREPOINT_ONLINE_BUSINESS', 'G_SUITE']) {
    assert.strictEqual(preflightBlocksRun(EMPTY, cloud), true, `${cloud}: EMPTY still blocks`);
  }
  assert.strictEqual(preflightBlocksRun(EMPTY, undefined), true, 'unknown cloud name: EMPTY still blocks');

  // Only EMPTY is ever actionable.
  for (const verdict of ['OK', 'UNKNOWN']) {
    assert.strictEqual(preflightBlocksRun({ verdict }, 'BOX_BUSINESS'), false, `${verdict} never blocks`);
  }
  assert.strictEqual(preflightBlocksRun(null, 'BOX_BUSINESS'), false, 'no probe result never blocks');
}

// ── isConnectionDrop ────────────────────────────────────────────────────────────
{
  const hangUp = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  assert.strictEqual(isConnectionDrop(hangUp), true, 'the exact error run 287c6ce8 died on');
  assert.strictEqual(isConnectionDrop(new Error('socket hang up')), true, 'message alone is enough');
  assert.strictEqual(isConnectionDrop(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })), true);

  // An HTTP reply is a real answer from CloudFuze and must not be retried.
  const http500 = Object.assign(new Error('Request failed with status code 500'), { response: { status: 500 } });
  assert.strictEqual(isConnectionDrop(http500), false, 'an HTTP 500 is not a dropped connection');
  const droppedButAnswered = Object.assign(new Error('socket hang up'), { response: { status: 502 } });
  assert.strictEqual(isConnectionDrop(droppedButAnswered), false, 'any response means it was answered');

  // A timeout may mean the server is still working on the request — retrying could double it.
  const timeout = Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED' });
  assert.strictEqual(isConnectionDrop(timeout), false, 'a timeout is not retried');
  assert.strictEqual(isConnectionDrop(null), false);
}

// ── retryOnConnectionDrop ───────────────────────────────────────────────────────
(async () => {
  const hangUp = () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });

  // A drop, then an answer: sent twice, the second time on a fresh connection.
  {
    const calls = [];
    const res = await retryOnConnectionDrop('test', async (over) => {
      calls.push(over);
      if (calls.length === 1) throw hangUp();
      return { data: 'ok' };
    });
    assert.strictEqual(res.data, 'ok');
    assert.strictEqual(calls.length, 2, 'retried exactly once');
    assert.strictEqual(calls[0].httpsAgent, undefined, 'first send uses the normal config');
    assert.ok(calls[1].httpsAgent, 'retry carries its own agent');
    assert.strictEqual(calls[1].httpsAgent.keepAlive, false, '…which never reuses a connection');
  }

  // Dropped twice: the second failure reaches the caller; never a third send.
  {
    let n = 0;
    await assert.rejects(retryOnConnectionDrop('test', async () => { n++; throw hangUp(); }), /socket hang up/);
    assert.strictEqual(n, 2, 'one retry, not a loop');
  }

  // A real answer or a timeout is not repeated (run ec204ed5's step that must not double up: start).
  for (const err of [
    Object.assign(new Error('Request failed with status code 500'), { response: { status: 500 } }),
    Object.assign(new Error('timeout of 60000ms exceeded'), { code: 'ECONNABORTED' }),
  ]) {
    let n = 0;
    await assert.rejects(retryOnConnectionDrop('test', async () => { n++; throw err; }));
    assert.strictEqual(n, 1, `${err.message}: sent once only`);
  }

  // Success first time: one send.
  {
    let n = 0;
    await retryOnConnectionDrop('test', async () => { n++; return {}; });
    assert.strictEqual(n, 1);
  }

  console.log('contentPreflight.test.js: ok');
})().catch((err) => { console.error(err); process.exit(1); });

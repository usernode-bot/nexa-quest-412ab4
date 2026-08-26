// Floor manager — generalized from "one active speaker" to N slots.
//
// A lease is a ROW, not a timer: `active_speakers.until` in the past means the
// slot is free, which is how a speaker whose tab died stops holding the floor
// without anyone having to notice. Renewal is an UPDATE on the row they
// already hold, so a person talking continuously never contends with anyone.
//
// Slots per tier: direct 1, group 3, large 1. When every slot is taken the
// claimant does not simply fail — their hand goes up automatically, so
// "you're 2nd in line" is a fact about the database rather than a guess made
// in the browser.

const { LIMITS } = require('./config');

// Any query here may run inside the caller's transaction (`client`) or on the
// pool; both expose `.query`.
async function reap(client, roomId) {
  await client.query(`DELETE FROM active_speakers WHERE room_id = $1 AND until <= NOW()`, [roomId]);
}

async function activeSpeakers(client, roomId) {
  const { rows } = await client.query(
    `SELECT user_id, username, until
       FROM active_speakers
      WHERE room_id = $1 AND until > NOW()
      ORDER BY claimed_at ASC`,
    [roomId]
  );
  return rows.map((r) => ({ userId: r.user_id, username: r.username, until: r.until }));
}

/**
 * Everyone with a hand up who is not already holding a slot, oldest hand
 * first. That ordering IS the queue — there is no separate queue table to
 * drift out of sync with who is actually still in the room.
 */
async function queueFor(client, roomId, limit) {
  const { rows } = await client.query(
    `SELECT p.user_id, p.username, p.hand_raised_at
       FROM room_participants p
      WHERE p.room_id = $1
        AND p.left_at IS NULL AND p.removed = FALSE
        AND p.hand_raised_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM active_speakers s
           WHERE s.room_id = p.room_id AND s.user_id = p.user_id AND s.until > NOW()
        )
      ORDER BY p.hand_raised_at ASC
      LIMIT $2`,
    [roomId, limit || 20]
  );
  return rows.map((r) => ({ userId: r.user_id, username: r.username, raisedAt: r.hand_raised_at }));
}

/**
 * Claim (or renew) a speaker slot.
 *
 * Resolves one of:
 *   { granted: true,  until, renewed }
 *   { granted: false, reason: 'queued', position, holders }
 *
 * Call inside a transaction that has already taken `SELECT ... FOR UPDATE` on
 * the room row — that lock is what makes "count the slots, then take one"
 * atomic against a second claimant doing the same thing.
 */
async function claim(client, roomId, user, tier) {
  await reap(client, roomId);

  const leaseMs = LIMITS.FLOOR_LEASE_MS;
  const slots = Math.max(1, (tier && tier.speakerSlots) || 1);

  // Already holding one? Renew — a continuous speaker never contends.
  const renew = await client.query(
    `UPDATE active_speakers
        SET until = NOW() + ($3 || ' milliseconds')::interval
      WHERE room_id = $1 AND user_id = $2 AND until > NOW()
      RETURNING until`,
    [roomId, user.id, String(leaseMs)]
  );
  if (renew.rowCount) {
    return { granted: true, until: renew.rows[0].until, renewed: true };
  }

  const held = await activeSpeakers(client, roomId);
  if (held.length < slots) {
    const ins = await client.query(
      `INSERT INTO active_speakers (room_id, user_id, username, until)
       VALUES ($1, $2, $3, NOW() + ($4 || ' milliseconds')::interval)
       ON CONFLICT (room_id, user_id)
       DO UPDATE SET until = EXCLUDED.until, username = EXCLUDED.username,
                     claimed_at = NOW()
       RETURNING until`,
      [roomId, user.id, user.username, String(leaseMs)]
    );
    // Holding the floor and having your hand up are mutually exclusive.
    await client.query(
      `UPDATE room_participants SET hand_raised_at = NULL
        WHERE room_id = $1 AND user_id = $2`,
      [roomId, user.id]
    );
    return { granted: true, until: ins.rows[0].until, renewed: false };
  }

  // Full. Raise their hand for them so the queue position is well-defined
  // rather than something the client has to ask for separately.
  await client.query(
    `UPDATE room_participants SET hand_raised_at = COALESCE(hand_raised_at, NOW())
      WHERE room_id = $1 AND user_id = $2`,
    [roomId, user.id]
  );
  const queue = await queueFor(client, roomId, 200);
  const idx = queue.findIndex((q) => q.userId === user.id);
  return {
    granted: false,
    reason: 'queued',
    position: idx >= 0 ? idx + 1 : queue.length + 1,
    holders: held,
  };
}

async function release(client, roomId, userId) {
  await client.query(`DELETE FROM active_speakers WHERE room_id = $1 AND user_id = $2`, [roomId, userId]);
}

async function releaseAll(client, roomId) {
  await client.query(`DELETE FROM active_speakers WHERE room_id = $1`, [roomId]);
}

async function holdsFloor(client, roomId, userId) {
  const { rowCount } = await client.query(
    `SELECT 1 FROM active_speakers WHERE room_id = $1 AND user_id = $2 AND until > NOW()`,
    [roomId, userId]
  );
  return rowCount > 0;
}

module.exports = { claim, release, releaseAll, activeSpeakers, queueFor, holdsFloor, reap };

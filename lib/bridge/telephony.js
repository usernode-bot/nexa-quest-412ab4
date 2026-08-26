// Telephony bridge — the seam, and an honest 501.
//
// The Stage 2 brief asked for the architecture to extend to a dial-in bridge:
// someone with no smartphone and no app calls a phone number, joins the room,
// speaks Indonesian, and the room hears them. Nothing about that is
// unreasonable, and nothing about it is buildable here yet:
//
//   - There is no inbound webhook surface: a carrier (SIP/PSTN) needs to reach
//     a stable endpoint with its own auth, and app containers are reachable
//     only through the platform's own iframe-token gate.
//   - There is no media transport for the audio leg once it arrives.
//   - Calling a telephony vendor directly would need a vendor API key, and
//     apps here may not ask users for API keys or hold third-party
//     credentials for this.
//
// Rather than pretend, the endpoint answers 501 with the same
// `platform_capability_missing` code the realtime-audio engine uses, and the
// room UI shows a visible "coming soon" row — in BOTH environments, because
// nothing here is gated on USERNODE_ENV. A dial-in number that only existed in
// staging would be worse than no dial-in number at all.
//
// When the platform grows the capability, this file is where the leg lands.

const CODE = 'platform_capability_missing';

function status() {
  return {
    available: false,
    code: CODE,
    label: 'Join by phone',
    note: 'coming soon',
    reason: 'Dial-in needs an inbound carrier webhook and a media transport; the platform provides neither yet.',
  };
}

/**
 * Would allocate a dial-in number + PIN for a room. Returns the blocked shape
 * so the caller has exactly one code path to write.
 */
async function requestDialIn(room) {
  return {
    ok: false,
    ...status(),
    roomCode: room && room.code ? room.code : null,
  };
}

module.exports = { status, requestDialIn, CODE };

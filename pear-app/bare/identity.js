// Deterministic peer handle generation.
// A pubkey ALWAYS maps to the same handle. Handles are display-only; the pubkey
// is the identity. No collision resistance guarantees - two peers CAN share a
// handle if their first bytes align (about 1-in-word*color*100 = 1/16000).
//
// Style: Italian ultras. Word-color-number.
// e.g. "forza-nero-42", "curva-rosso-07".
//
// TODO: Full 96-word Italian ultras list pending native Italian speaker review
//       per architect's open question 3 (ARCHITECTURE.md section 13).
//       Current list is intentionally conservative: common football / stadium
//       vocabulary, nothing that could translate to a slur.

const b4a = require('b4a')

// Wave 6 T11: expanded to 96 candidates. Categories:
//   - Football/curva vocabulary (verbs, nouns, adjectives)
//   - Italian regions
//   - Italian months
//   - No player names or club names (spec §15 trademark discipline)
// pending native italian speaker review before public v1
const WORDS = [
  // -- Football / curva / stadium vocabulary (~60)
  'curva',       // "curve" - stadium terraces (Curva Sud, Curva Nord)
  'forza',       // "strength", "come on"
  'tifoso',      // "fan"
  'ultra',       // "ultra" fan
  'bandiera',    // "flag"
  'coro',        // "chant"
  'stadio',      // "stadium"
  'gol',         // "goal"
  'tridente',    // trident (formation)
  'catenaccio',  // defensive style
  'derby',       // derby
  'tifo',        // fan support (noun)
  'squadra',     // team
  'campione',    // champion
  'gladiatore',  // gladiator
  'sciarpa',     // scarf
  'gradinata',   // terrace steps
  'trasferta',   // away trip
  'coppa',       // cup
  'partita',     // match
  'campo',       // pitch
  'porta',       // goal (net)
  'rete',        // net (also goal in football)
  'palla',       // ball
  'passaggio',   // pass
  'tiro',        // shot
  'punizione',   // free kick
  'rigore',      // penalty
  'fallo',       // foul
  'cartellino',  // card
  'arbitro',     // referee
  'capitano',    // captain
  'portiere',    // goalkeeper
  'attacco',     // attack
  'difesa',      // defense
  'centrocampo', // midfield
  'contropiede', // counterattack
  'melina',      // slow ball control
  'primavera',   // youth team
  'scudetto',    // "shield" - Serie A title
  'coppetta',    // small cup
  'trionfo',     // triumph
  'vittoria',    // victory
  'sconfitta',   // defeat
  'pareggio',    // draw
  'rimonta',     // comeback
  'goleada',     // goal spree
  'saluto',      // salute
  'battaglia',   // battle
  'fortezza',    // fortress
  'roccia',      // rock
  'lupo',        // wolf
  'aquila',      // eagle
  'leone',       // lion
  'toro',        // bull
  'stella',      // star
  'onda',        // wave
  'fiamma',      // flame
  'tempesta',    // storm
  'cuore',       // heart

  // -- Italian regions (20)
  'torino',
  'milano',
  'roma',
  'napoli',
  'palermo',
  'genova',
  'bologna',
  'firenze',
  'venezia',
  'verona',
  'bari',
  'catania',
  'sicilia',
  'sardegna',
  'toscana',
  'lombardia',
  'piemonte',
  'liguria',
  'lazio',
  'calabria',

  // -- Italian months (12)
  'gennaio',
  'febbraio',
  'marzo',
  'aprile',
  'maggio',
  'giugno',
  'luglio',
  'agosto',
  'settembre',
  'ottobre',
  'novembre',
  'dicembre',

  // -- Extra neutral football/curva adjectives (4) to round to 96
  'invincibile', // unbeatable
  'leggenda',    // legend
  'eterno',      // eternal
  'orgoglio'     // pride
]

// 8-color list.
const COLORS = [
  'nero', // black
  'bianco', // white
  'rosso', // red
  'blu', // blue
  'giallo', // yellow
  'verde', // green
  'oro', // gold
  'viola' // purple
]

/**
 * Convert pubkey to a deterministic handle.
 * @param {Buffer|Uint8Array|string} pubkey hex string OR raw bytes
 * @returns {string} e.g. "forza-nero-42"
 */
function handleFromPubkey(pubkey) {
  const buf = toBuffer(pubkey)
  if (buf.length < 3) {
    throw new RangeError('pubkey must be at least 3 bytes')
  }
  // Take first byte for word, second for color, last two hex chars for number 0-99.
  const wordIdx = buf[0] % WORDS.length
  const colorIdx = buf[1] % COLORS.length
  const lastByte = buf[buf.length - 1]
  const num = String(lastByte % 100).padStart(2, '0')
  return `${WORDS[wordIdx]}-${COLORS[colorIdx]}-${num}`
}

function toBuffer(pubkey) {
  if (typeof pubkey === 'string') {
    // Accept hex.
    if (!/^[0-9a-fA-F]+$/.test(pubkey)) {
      throw new TypeError('pubkey string must be hex')
    }
    if (pubkey.length % 2 !== 0) {
      throw new TypeError('pubkey hex must have even length')
    }
    return b4a.from(pubkey, 'hex')
  }
  if (pubkey instanceof Uint8Array) return b4a.from(pubkey)
  throw new TypeError('pubkey must be hex string or Uint8Array')
}

module.exports = { handleFromPubkey, WORDS, COLORS }

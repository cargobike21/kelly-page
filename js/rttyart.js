/* Kelly Page -- RTTY art, banners and QSL cards for the RTTY page (UMD, pure).
 *
 * Over P25 an art piece costs almost nothing: the over carries a token -- [ART:SHIP], [BANNER:73 DE VK4XXX],
 * [QSL:VK4ABC:599] -- and every Kelly prints the picture from its own copy of this file. On the HF modem the
 * picture itself is keyed, line by line, the way RTTY art was always sent. Everything here uses only characters
 * Baudot can print (no *, _, ~, \, +, @), lines of 68 columns at most. All pieces are original to Kelly Page.
 *
 *   KellyArt.expand(text, {from, call, date, time}) -> text with the tokens replaced by the pictures
 *   KellyArt.banner(text) -> 7-line block letters;  KellyArt.list -> [{id, name, lines}]
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KellyArt = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const ART = {
    SHIP: { name: 'Tall ship', lines: [
      '                    !',
      '                   $!$                $',
      '                  $$!$$              $$$',
      '                 $$$!$$$            $$$$$',
      '                $$$$!$$$$          $$$$$$$',
      '               $$$$$!$$$$$        $$$$$$$$$',
      '              $$$$$$!$$$$$$      $$$$$$$$$$$',
      '                    !                 !',
      '       #####################################',
      '        ###  P25X  ##################  RTTY ###',
      '          #################################',
      "  -'-'-'-'-'-'-'-'-'-'-'-'-'-'-'-'-'-'-'-'-'-'-'-'-",
      "    '-'-'-'-'-'-'-'-'-'-'-'-'-'-'-'-'-'-'-'-'-'-'",
    ] },
    TOWER: { name: 'Repeater tower', lines: [
      '                     (  (  (  O  )  )  )',
      '                              !',
      '                             XXX',
      '                             X X',
      '                            XXXXX',
      '                            X X X',
      '                           XXXXXXX',
      '                           X  X  X',
      '                          XXXXXXXXX',
      '                          X   X   X',
      '                         XXXXXXXXXXX',
      '                         X    X    X',
      '                 ---------XXXXXXXXXXX---------',
      '                       P25X  REPEATER  SITE',
    ] },
    TELETYPE: { name: 'Teleprinter', lines: [
      '          ....................................',
      '          :  ------------------------------  :',
      '          :  !  RYRYRYRYRYRYRYRYRYRYRYRYRY !  :',
      '          :  !  THE QUICK BROWN FOX ...    !  :',
      '          :  ------------------------------  :',
      '       ..........................................',
      '       : (O)  ### ### ### ### ### ### ###   (O) :',
      '       :       ### ### ### ### ### ### ###      :',
      '       :         ### ### ### ### ### ###        :',
      '       :           ########################     :',
      '       :........................................:',
      '                  60 WPM -- 45.45 BAUD',
    ] },
    TREE: { name: 'Seasons greetings', lines: [
      '                         $',
      '                        $$$',
      '                       $$O$$',
      '                      $$$$$$$',
      '                     $$O$$$O$$',
      '                    $$$$$$$$$$$',
      '                   $$O$$$O$$$O$$',
      '                  $$$$$$$$$$$$$$$',
      '                        ###',
      '                        ###',
      '            SEASONS GREETINGS DE {FROM}',
    ] },
    ANTENNA: { name: 'Yagi', lines: [
      '            !     !     !     !     !     !     !',
      '            !     !     !     !     !     !     !',
      '       -----!-----!-----!-----!-----!-----!-----!----)',
      '            !     !     !     !     !     !     !',
      '            !     !     !     !     !     !     !',
      '                              !',
      '                              !',
      '                              !',
      '                        ------!------',
      '                     {FROM} -- BEAMING YOUR WAY',
    ] },
    SUN: { name: 'Sunrise', lines: [
      '                    .    !    .',
      '               .     .   !   .     .',
      '                  .   ooooooo   .',
      '          -  -  -  ooooooooooooo  -  -  -',
      '                 ooooooooooooooooo',
      '      ---------------------------------------------',
      '          GOOD MORNING FROM {FROM} -- QRV ON P25X',
    ] },
  };
  // 5 x 7 block letters for banners (classic teleprinter banners: each letter drawn with itself)
  const F = {
    A: '01110 10001 10001 11111 10001 10001 10001', B: '11110 10001 10001 11110 10001 10001 11110', C: '01110 10001 10000 10000 10000 10001 01110',
    D: '11110 10001 10001 10001 10001 10001 11110', E: '11111 10000 10000 11110 10000 10000 11111', F: '11111 10000 10000 11110 10000 10000 10000',
    G: '01110 10001 10000 10111 10001 10001 01111', H: '10001 10001 10001 11111 10001 10001 10001', I: '01110 00100 00100 00100 00100 00100 01110',
    J: '00111 00010 00010 00010 00010 10010 01100', K: '10001 10010 10100 11000 10100 10010 10001', L: '10000 10000 10000 10000 10000 10000 11111',
    M: '10001 11011 10101 10101 10001 10001 10001', N: '10001 10001 11001 10101 10011 10001 10001', O: '01110 10001 10001 10001 10001 10001 01110',
    P: '11110 10001 10001 11110 10000 10000 10000', Q: '01110 10001 10001 10001 10101 10010 01101', R: '11110 10001 10001 11110 10100 10010 10001',
    S: '01111 10000 10000 01110 00001 00001 11110', T: '11111 00100 00100 00100 00100 00100 00100', U: '10001 10001 10001 10001 10001 10001 01110',
    V: '10001 10001 10001 10001 10001 01010 00100', W: '10001 10001 10001 10101 10101 10101 01010', X: '10001 10001 01010 00100 01010 10001 10001',
    Y: '10001 10001 01010 00100 00100 00100 00100', Z: '11111 00001 00010 00100 01000 10000 11111',
    0: '01110 10001 10011 10101 11001 10001 01110', 1: '00100 01100 00100 00100 00100 00100 01110', 2: '01110 10001 00001 00010 00100 01000 11111',
    3: '11111 00010 00100 00010 00001 10001 01110', 4: '00010 00110 01010 10010 11111 00010 00010', 5: '11111 10000 11110 00001 00001 10001 01110',
    6: '00110 01000 10000 11110 10001 10001 01110', 7: '11111 00001 00010 00100 01000 01000 01000', 8: '01110 10001 10001 01110 10001 10001 01110',
    9: '01110 10001 10001 01111 00001 00010 01100', '-': '00000 00000 00000 11111 00000 00000 00000', '.': '00000 00000 00000 00000 00000 01100 01100',
    '!': '00100 00100 00100 00100 00100 00000 00100', '?': '01110 10001 00001 00010 00100 00000 00100', '/': '00001 00001 00010 00100 01000 10000 10000',
    ' ': '00000 00000 00000 00000 00000 00000 00000',
  };
  const PER_LINE = 11;   // 6 columns a letter, 66 columns
  function banner(text) {
    const s = String(text || '').toUpperCase().replace(/[^A-Z0-9 .!?/-]/g, '').trim().slice(0, 33);
    // whole words to a line where they fit (a word longer than a line is cut)
    const lines = [];
    for (const w of s.split(/\s+/)) {
      const cur = lines[lines.length - 1];
      if (cur != null && `${cur} ${w}`.length <= PER_LINE) lines[lines.length - 1] = `${cur} ${w}`;
      else for (let i = 0; i < w.length; i += PER_LINE) lines.push(w.slice(i, i + PER_LINE));
    }
    const out = [];
    for (const chunk of lines) {
      for (let r = 0; r < 7; r++) {
        out.push(chunk.split('').map(ch => { const row = (F[ch] || F[' ']).split(' ')[r]; const ink = /[A-Z0-9]/.test(ch) ? ch : '#'; return row.replace(/1/g, ink).replace(/0/g, ' '); }).join(' ').replace(/\s+$/, ''));
      }
      out.push('');
    }
    return out;
  }
  function qsl(to, rst, from, date, time) {
    const w = 52, row = t => `#  ${String(t).slice(0, w - 6).padEnd(w - 6)}  #`, bar = '#'.repeat(w);
    return [bar, row(''), row(`QSL   QSL   QSL`), row(''), row(`TO RADIO   ${to || '?'}`), row(`FROM       ${from || '?'}`), row(`UR RTTY    ${rst || '599'}   ${date || ''} ${time || ''}`),
      row('VIA P25X -- DIGITAL VOICE. TOTAL DATA.'), row('TNX FER THE QSO -- 73'), row(''), bar];
  }
  const fill = (lines, v) => lines.map(l => l.replace(/\{FROM\}/g, v.from || 'P25X'));
  // tokens -> pictures; anything unknown stays as it was
  function expand(text, v = {}) {
    return String(text || '').replace(/\[(ART|BANNER|QSL):([^\]\n]{0,40})\]/gi, (all, kind, arg) => {
      kind = kind.toUpperCase();
      if (kind === 'ART') { const a = ART[arg.trim().toUpperCase()]; return a ? `\n${fill(a.lines, v).join('\n')}\n` : all; }
      if (kind === 'BANNER') return `\n${banner(arg).join('\n')}`;
      const [to, rst] = arg.split(':');
      return `\n${qsl(String(to || '').toUpperCase(), String(rst || '599').toUpperCase(), v.from, v.date, v.time).join('\n')}\n`;
    });
  }
  const hasToken = text => /\[(ART|BANNER|QSL):[^\]\n]{0,40}\]/i.test(text || '');
  return { expand, banner, qsl, hasToken, list: Object.entries(ART).map(([id, a]) => ({ id, name: a.name, lines: a.lines })) };
});

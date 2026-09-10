# Tantalum audit — Fluke 5700A, all 17 assemblies

**122 solid tantalum capacitors on 15 boards.** A18 and A19 carry none.
For each one this establishes two numbers and shows the working for both: the
**rated voltage**, confirmed against the parts-list row rather than parsed from a
description string, and the **working voltage**, established by following the net
on the schematic sheet.

> **A20 has four tantalums, and the app cannot see them.** This audit was
> commissioned on the understanding that A20 had none. It has four — C1, C5, C17
> and C100, all surface-mount — and one of them, **C1, a 220 µF 10 V bulk
> reservoir on the +5 V logic rail at 52 % of rating, belongs on the recap
> list.** The reason they looked absent is the known unfixed bug in
> `js/caps.js`: `capType` anchors its match on `/^CAP,/`, and A20's parts-list
> rows are printed `CAPACITOR SMR,CAP,TA,220UF,…`, so all 50 of A20's
> capacitors type as `null` and none of them is recognised as a tantalum.
> `data/a20.caps.json` already curates all four correctly, with traced nets —
> the data is fine, the classifier is not. Details in *The A20 blind spot* below.
> Per the brief nothing under `js/` was touched.

Audited 2026-08. Sources: the 1996 Series II service manual text layer
(`pdftotext -layout`, never OCR), the Rev 9 Chapter 6 replaceable-parts scan, and
the Rev 9 Chapter 7 schematic sheets rendered at 400 dpi and read by eye.

---

## Bottom line

- **Nothing is over its rating.** Not at the recorded working voltage, and not at
  the worst case of the published tolerance band either. The tightest part in the
  instrument reaches 95 % of rating at the extreme of its zener's tolerance and
  90 % nominally, which is a real design margin rather than a data error — see
  A16 C9 below.
- **All 122 ratings are confirmed twice.** Every designator expands out of a
  1996 parts-list row whose description matches the dataset exactly (122 of 122,
  no mismatches), and the Rev 9 list agrees on every voltage on A4–A17. **One
  cross-list disagreement exists and it is on A20 C100** — Series II 20 V,
  Rev 9 16 V — which moves it from 26 % to 33 % of rating and changes nothing.
  Buy to these numbers.
- **Twelve entries were wrong and are corrected.** One of them was the worst
  ratio in the whole instrument and turns out to be one of the safest parts on
  the board.
- **Four of the five untraced are now traced.** A13's C56–C59 came in carrying
  `appliedV: null`; both plates of each turn out to sit at 0 V, so they are
  recorded as 0 V rather than as unknowns. **One remains unresolved** and stays
  that way: A5 C32, which is not drawn on any sheet in either manual.
- **105 were confirmed unchanged.**
- **46 parts sit at 50 % of rating or more** at the recorded value; 49 do at the
  worst case of the published band. Those plus A5 C32 are the recap list, and
  they are **rows 1–51** of the table.

### What to actually order

| Priority | Parts | Why |
|---|---|---|
| **1** | **A16 C9**, **A16 C21** — 15 µF, currently 20 V | 90 % and 75 % of rating, and they are 20 V parts by design, not by accident. Fit **35 V minimum**, 50 V if the case size allows. |
| **2** | The **±17 S / ±17 LH family** — 26 parts at 68–75 % | 4.7 µF, 10 µF and 22 µF **25 V** parts on rails whose published band tops out at +18.0 V / −18.7 V. Fit **50 V**. This is the bulk of the job: A5 ×4, A6 ×4, A7 ×9, A9 ×1, A12 ×2, A13 ×2, A17 ×4. (A9's other three, A10 ×2 and A11 ×2 are on the same rails but are 35 V and 50 V parts, so they sit at 34–49 % and can wait.) |
| **3** | **A4 C1, C4** — 10 µF 35 V at 69 % | They see the full 24 V across the fan, not one 12 V rail. Fit **50 V**. |
| **4** | **A14 C13**, **A15 C34** — 22 µF 10 V at 64 % on +5 RLH | +5 RLH is a ~6 V rail despite its name. Fit **25 V**. |
| **5** | The **±15 family** at 60–63 %, the **+5 LH / +5 V** 10 V parts at 51–54 %, and **A20 C1** (220 µF 10 V at 52 %) | Replace if the board is out anyway. A20 C1 is the one the app will not show you — see the note at the top. |
| — | Everything below row 51 in the table | Under 50 % on both measures. Leave alone unless it has failed. |

Seventeen distinct part types cover all 122. The dominant one by far is
`CAP,TA,4.7UF,±20%,25V` (Fluke stock 807644, Vishay/Sprague 199D475X0025BA1) at
55 pieces, of which 20 are on the ±17 rails and want upsizing to 50 V. A20's four
are surface-mount and share no part number with anything else in the instrument.

---

## How the rated voltage was established

Not by parsing a description. For each board the 1996 parts table was pulled out
of the text layer, each row's **reference-designator range expanded** (`C93-99,
C106, C107` → nine refs), and every tantalum designator matched back to the row
it came from. The expansion was checked against the row's printed **Tot Qty**
column, which is what catches a mis-split range.

The result: **122 designators expand out of the 1996 rows, and 122 tantalums
exist in the datasets — the same 122, with zero description mismatches.** No
merged range has attached one part's description to another part's reference,
which is the failure mode `references/pitfalls.md` warns about.

The Rev 9 Chapter 6 scan was then read independently, page by page, for every one
of those rows on A4 through A17. **No voltage rating there contradicts the 1996
list.** The one place the two revisions disagree on a tantalum's rating is
**A20 C100** — Series II 20 V, Rev 9 16 V, the same 2.2 µF part in the same
place. At 5.2 V applied that is 26 % or 33 % of rating; neither is a concern, and
the disagreement is already recorded in `data/a20.caps.json`. **Fit a 20 V part
or better** and the question does not arise.

Two further rows differ in ways that change nothing about what to buy:

- **A11 C30, C31** — re-sourced. 1996 gives stock 929302 with a `,6032` case-size
  suffix; Rev 9 gives Fluke house number 780478 (mfr code 89536, Fluke itself)
  and drops the case code. **1.5 µF / 50 V in both.** Order by rating and case
  size, not by either stock number.
- **A5 C32** — present in the 1996 row of twelve, absent from the Rev 9 row of
  eleven, and not moved to a different row: the adjacent polyester row reads
  `C33-37`, not `C32-37`, and its printed quantity of 33 corroborates that
  reading. C32 is one of a block of A5 positions (C24, C30, C31, C32, C54,
  C69-C71) that Rev 9 depopulated. See the untraced list.

Rev 9 also has two typographic traps that would mislead a recap but do not affect
this audit, because the datasets read the 1996 list: **A12 C34/C35/C86/C87** and
**A14 C8/C9** are printed as `CAP,TA` in Rev 9 and are aluminium — stock 822403
and 816843, Nippon Chemi-Con KME series, spelled out correctly as `CAP,AL` on
three other pages. Do not buy tantalums for those six.

## How the working voltage was established

By following the net on the sheet. The table marks each entry **traced** or
**inferred**; exactly one of the 122 remains inferred, and that one is A5 C32,
which is not on the schematic at all.

**What this pass re-read at 400 dpi, rather than taking on trust.** Every entry
at 50 % of rating or more, plus every entry whose note described something other
than a plain rail decoupler. In practice that meant these blocks, which between
them carry 60 of the 122:

| Sheet | What it settled |
|---|---|
| A16 sh2 (p75) | C9 across VR15 / R19, C21 across VR18 / R57 — the two tightest parts in the instrument |
| A7 sh2 (p27) | C15 across Q1's E-B, **not** its C-E — the audit's biggest correction |
| A16 sh3 (p76), A11 sh1 (p47) | C45, C19, C20 — the same E-B error three more times |
| A17 sh2 (p81) | C55 on U60's CT pin, C57 and C58 on a +5 V made from +5 LH through L51, not from A19 |
| A12 sh2 (p57) | C48 on VREF at U30 pin 3, not on +15S |
| A6 sh1 (p22) | all eleven of A6's, in one view — the ±17 / ±5 entry, VR1's `+12` node and VR5/CR8/CR9's `−9.5` node |
| A7 sh3 (p28) | C21, C22, C23, C24, C52, C53, C60, C61 — the ±17 S and ±17 LH entry with chokes L1–L3, L7–L9 |
| A13 sh3 (p62) | C94, C95, C96, C97, C98, C99, C106, C107 — the whole ±17 / ±15 / ±5 entry, confirming C106/C107 sit after L1/L2 on `+5S` / `−5S` |
| A14 sh1 (p66) | C6, C7, C11, C12, C13 — ±15 S and the LH group at P612 |
| A4 sh3 (p16) | C1 and C4 across the +12V FAN / −12V FAN pair, ahead of R2 and R3 — 24 V, not 12 |

Two conventions matter for reading the numbers:

**Negative rails are recorded as magnitudes.** The supply tables print them
unsigned — Table 2-2's `-12 VOLTS ... 12V` and Table 2-10's `-17S ... -17.000V`
— and what a capacitor cares about is the magnitude across it plus the polarity
of its plates. Every entry here has had its polarity checked against the `+`
marking on the sheet.

**The "Worst-case V" column is the published band, not a guess.** Where a rail has
a stated tolerance the audit records the design nominal in `appliedV` and this
column shows the far end of the band, with its citation. It exists because a
capacitor does not experience the nominal — it experiences whatever the rail is
doing on the day, and a rail at the top of its acceptance window is still a
passing rail. It changes no recap decision anywhere in this instrument (nothing
crosses a band boundary because of it), but it is the honest number and it is
where the extra 3–7 % on the ±17 family comes from.

---

## The twelve corrections

| Board · Ref | Was | Is now | What was wrong | Evidence |
|---|---|---|---|---|
| **A7 C15** | 15 V, **94 %** | 0.8 V, **5 %** | Recorded across Q1 collector-to-emitter. It is across **emitter-to-base**. | Fig 7-7 sh2 (Ch7 p27), HYBRID HEATER CONTROL CIRCUIT. Q1 TIP32: emitter to the +8 RLH stub, collector down-left to C1 and HR2 pin 1 (the 42 Ω element), **base out of the base bar to the right, to HR2 pin 6** — and C15's second plate lands on that line at the junction dot. A forward-conducting E-B junction clamps it at V_EB. |
| **A16 C45** | 20 V, 57 % | 0.8 V, 2 % | Recorded on the +8RLH rail. Across Q38's **emitter-base**. | Fig 7-19 sh3 (Ch7 p76), beside P702. Identical circuit to A7's, drawn vertically: +8RLH stub down to the line leaving Q38's base for the hybrid's pin 6. |
| **A11 C19** | 5.0 V, 14 % | 0.8 V, 2 % | Recorded on +5FR1R. Across Q2's **emitter-base**. | Fig 7-11 sh1 (Ch7 p47), under the Q2/Q3 heat-sink boxes. Q2 and Q3 (both TIP32) share the +5FR1R line at their emitters; C19 hangs from it to Q2's base and the left hybrid's pin 6. Sheet even labels it `2.2uF TANT`. |
| **A11 C20** | 5.0 V, 14 % | 0.8 V, 2 % | Same, on Q3. | Same sheet, mirror position. |
| **A17 C55** | 5.2 V, inferred, "+5V dig from A19 F5" | 5.1 V, **traced** | Not a decoupler at all. It is U60's **7705A CT timing capacitor**. | Fig 7-21 sh2 (Ch7 p81), POWER UP AND RESET CIRCUITRY. CT node = U60 pin 3, with R52 (1 kΩ) and RESET SWITCH SW51; sheet annotates `TIME CONSTANT IS 130 mSEC`. |
| **A17 C57** | 5.2 V, inferred, "from A19 F5" | 5.1 V, **traced** | The rail is made on A17, not brought from A19. | Same sheet, INPUT POWER FILTER block: `+5LH FROM SHEET 1` → **L51 (3 turns)** → node labelled `+5V`, TP52 VCC2, with C54/C57/C59 to GND2. The regulator behind it is A17's own U8, unfused — F5 on A19 protects nothing here. |
| **A17 C58** | 5.2 V, inferred, "from A19 F5" | 5.1 V, **traced** | Same rail. | Same sheet, the bulk member of the row captioned `BYPASS CAPACITORS` on that +5V node. |
| **A8 C22** | 5.0 V, 25 % | 6.4 V, 32 % | +5 RLH is not a 5 V rail. | Table 2-10: `+5RLH  +5.975V  ±425 mV` at A17 TP14; §2-73 says R13/CR34/CR35 raise U11's output on purpose. 6.40 V is the top of the band and is what A5, A13, A14, A15 and A17 already used. |
| **A9 C33** | 5.0 V, 20 % | 6.4 V, 26 % | Same. | Same. |
| **A10 C6** | 5.0 V, 20 % | 6.4 V, 26 % | Same. | Same. |
| **A9 C36** | 5.0 V, 50 % | 5.1 V, 51 % | +5 LH's published nominal is 5.1 V, not 5. | Table 2-10, A17 TP11. Every other board already used 5.1. |
| **A12 C48** | 15 V, **inferred** on +15S | 15 V, **traced** on VREF | Not on a rail at all. The last inferred entry above 50 %. | Fig 7-14 sh2 (Ch7 p57), block captioned DC SENSE BUFFER: VREF → R32 (120 Ω) → U30 pin 3, with C48 filtering that node to common. C49 and C50 are the parts on ±15 either side of U30. VREF is the DAC output the amplitude loop works against — 3.16 V at 1 V rms/1 kHz (§5-17 step 1, TP3), 6.5 V during internal cal. The 15 V stands as the bound U30's own supply sets, so the number did not move; the net did. |

Four of the twelve are **the same mistake made four times**: a tantalum bridging
a heater pass transistor's base-emitter junction, recorded as if it were on the
rail that feeds the emitter. The instrument has six of these capacitors —
**A7 C15, A11 C19, A11 C20, A15 C14, A15 C19 and A16 C45** — all the same 2.2 µF
part family, all bridging a TIP32's E-B in a hybrid heater control block.
**A15's two already had it right at 0.8 V**, which is what made the pattern
visible: the evidence for the correct answer was sitting in the dataset one board
over, exactly as the A12 C1/C2 case in `references/pitfalls.md` describes.

That entry is worth extending. It currently teaches "re-trace the net; the answer
is usually the rail feeding the circuit rather than the node the part is on".
This audit found a second, narrower shape of the same error, and it is worth
naming because it recurred six times in one instrument: **a tantalum drawn beside
a pass transistor is as likely to be across its base-emitter junction as across
its collector-emitter, and the two differ by the whole rail.** The tell is that
the second plate lands on the line leaving the *base bar*, not on a slanted
collector lead. A base-emitter part is self-limiting at V_EB and is never a recap
priority; a collector-emitter part sees whatever the transistor is dropping.
Getting it backwards produced both the highest false alarm in this audit
(A7 C15 at 94 %) and, had it gone the other way, would have hidden a real one.

---

## A7 C15 — resolved, and it was the biggest error in the audit

This was the instrument's worst ratio: 15 V applied, 16 V rated, 94 %. Both parts
lists agree the part is 2.2 µF **16 V** (stock 706804, Vishay 199D225X0016AA1 —
the manufacturer part number's `0016` field confirms it independently), so the
rating was never the suspect. The rail was.

The previous note said C15 sat "across the HR2 heater's pass transistor — its +
plate on Q1's emitter at +8 RLH and its other plate on Q1's collector", and
reasoned from there that the voltage was whatever Q1 was dropping, up to the full
unregulated rail. That would indeed have put it over its rating: fault code 3609
accepts +10 V to +20 V at A17's TP17.

Read at 400 dpi, the sheet does not draw that. Q1's collector goes **down-left**
to the node carrying C1 (0.22 µF to S COM) and on to HR2 pin 1. C15's second
plate is on the **base** line — the horizontal that leaves the base bar to the
right and runs to HR2 pin 6, the hybrid's heater-control output, with a junction
dot where C15 drops onto it.

So C15 is the pass transistor's base-emitter bypass. The E-B junction
forward-conducts, clamping it at V_EB ≈ 0.7–0.8 V while the heater is driven and
falling to zero when the hybrid stops sinking base current. It cannot go the
other way either: pin 6 only sinks, through an internal resistor to S COM, so the
base can never be pulled above the emitter. The `+` mark is on the +8 RLH plate,
which is the correct polarity for a conducting PNP E-B junction.

**5 % of rating. The 16 V part is right where it is and needs no upsizing.** The
earlier advice to fit a 25 V or 35 V part was sound engineering applied to the
wrong node.

## A16 C9 — resolved the other way. It is real.

18 V on a 20 V part, 90 %, and this one survived every attempt to find an error
in it.

**The rating is right.** Both lists give `CAP,TA,15UF,±20%,20V`, Fluke stock
807610, Vishay 199D156X0020DA1 — and the manufacturer part number encodes it
independently: `156` = 15 µF, `X` = ±20 %, `0020` = 20 V. The same stock number
appears on A8 as C22, where it runs at 6.4 V, so 807610 unambiguously means
15 µF / 20 V across the manual.

**The rail is right.** Figure 7-19 sheet 2 (Ch7 p75), at the `SC+ (PG2D8)` arrow:
C9 sits directly in parallel with VR15 and with C8 (0.22 µF), between the SC+
node and the amplifier's OUT node, its `+` plate on the SC+ side. VR15's
parts-list row is `ZENER,UNCOMP,18.0V,5%,7.0MA,0.4W`. And it is not a fault clamp
that idles: **R19, 68 kΩ 1 W**, feeds that node from the high side, so VR15
carries current continuously and is the shunt regulator that defines the rail. A
1 W rating on a 68 kΩ resistor implies hundreds of volts across it, which is what
you would expect feeding a floating supply from the ±PA rails.

So SC+ really does stand 18 V above OUT whenever the amplifier is powered.
Over the zener's ±5 % that is 17.1–18.9 V, i.e. **86–95 % of rating**.

**This is a part Fluke ran at 90 % of rating.** Not a mis-trace, not a
transcription error. It is the single most important entry in this audit and the
first thing to replace. Fit 35 V minimum; 50 V if the case size allows, because
Vishay's MnO2 derating table asks for *more* derating above 15 V, not less.

## A16 C21 — 75 %, and the asymmetry is genuine

Same topology on the negative side: C21 in parallel with VR18 and C20 between
PACOM and SC−, fed from −PA by R57 (68 kΩ 1 W). The obvious suspicion — that a
symmetric ± pair should have the same zener and one of the two was misread — is
wrong. The parts list gives **VR15 as `ZENER,UNCOMP,18.0V,5%`** and **VR18 as
`ZENER,UNCOMP,15.0V,5%,8.5MA`**. The negative half genuinely runs 3 V lower.
That asymmetry is exactly why two identical 15 µF 20 V parts land at 90 % and
75 %. Replace C21 with C9 and fit the same 35 V or better.

## The `17.865 V` group — where it came from, and whether it is right

Seven parts carry 17.865 V (A6 C5, C6; A7 C7, C24, C38, C53, C61) and six carry
17.475 V (A6 C7, C8; A7 C6, C23, C52, C60). The precision is suspicious and the
suspicion was worth acting on, but the answer is that the numbers are traceable
and the net assignments behind them are all correct.

**Origin.** Both come from `data/a17.testpoints.json`, which sets TP8 (+17 S) to
17.475 V and TP12 (−17 S) to −17.865 V. Neither figure appears anywhere in the
manuals. They are **band centres**: Table 2-10 prints the nominal cells as
+17.000 V ±475 mV and −17.000 V ±835 mV, but Figure 7-21 sheet 1's own annotation
and §5-2's fault codes both put the band half a volt higher — 3600 gives +17.0 to
+18.0 V, 3601 gives −17.0 to −18.7 V. A17's dataset resolved that two-against-one
disagreement by reading the table's printed nominal as the *near limit* of the
band and recentring: (17.0 + 17.95)/2 = 17.475, (17.03 + 18.7)/2 = 17.865. That
reasoning is documented in the A17 file and it is sound for a test point.

**It was propagated, and correctly.** Every one of the thirteen was re-checked
against the sheet. A6 sheet 1's power entry draws the lot in one view: P101
22A/22C `+17 S` → C7 → L4 (6T) → `+17S` → C8 → VR1 (5.1 V) → `+12` → C50; and
23A/23C `−17 S` → C5 → L3 → `−17S` → C6 → VR4 (5.1 V) → `−12`. A7 sheet 3's
entry block likewise: C60 and C61 across the connector pins, C23 and C24 on the
load side of chokes L2 and L3, and C52 and C53 on `+17LH` / `−17LH`, which L7 and
L8 derive from ±17 S. All thirteen are on the net they claim.

**Two things are nonetheless worth knowing before you order.**

1. **It is not Fluke's design nominal.** The instrument's own drawings use a round
   17. A6 sheet 1 labels the node below VR5 (6.2 V) as `−11` and the node after
   CR8/CR9 as `−9.5`; both only come out right from a −17.0 rail, not a −17.865
   one. Table 2-10's nominal cells say ±17.000 V. So 17.475 / 17.865 is a
   *test-point acceptance statistic*, not a design voltage.
2. **The same rail is recorded as a round 17 on five other boards** — A5, A9,
   A12, A13 and A17 — so the identical 25 V part shows 68 % on those and 70–71 %
   on A6 and A7. That is an internal inconsistency in the dataset, not a
   disagreement about the circuit.

For a capacitor, neither figure is the one that matters: **the worst case is
+18.0 V and −18.7 V**, from the fault codes. On a 25 V part that is 72 % and
75 %. The "Worst-case" column in the table shows this for all 31 tantalums on
these rails, and it is the number to size a replacement against. The `appliedV`
values were left as they were rather than rewritten across eight boards, because
changing 31 entries would trade one convention for another without moving a
single part out of its band — the 26 that are 25 V parts are "High, replace"
either way, and the other five are 35 V and 50 V parts nowhere near the line.

---

## The five untraced — four resolved, one that cannot be

### A13 C56, C57, C58, C59 — resolved. Both plates are at 0 V.

These four 22 µF **10 V** parts were the audit's most uncomfortable unknowns: the
lowest-rated tantalums with no voltage against them. They were recorded as
"MC1494L pin 14 output coupling, DC equals the multiplier output offset, which no
manual publishes — measure it". That framing made the unpublished offset the
blocker. It is not: **you do not need the offset if you trace both ends.**

On Figure 7-15 sheet 1 (Ch7 p60) and sheet 2 (p61):

- **Each pin 14's only DC path is a resistor to S COM** — R32 (20 kΩ) on U16,
  R50 (10 kΩ) on U19, R79 (10 kΩ) on U15. There is no pull-up to +15 S on any of
  the three multipliers. A pin with nothing but a resistor to common sits at
  common.
- **Each far plate lands on an op-amp's inverting input held at virtual ground**
  — C56/C57 on the R1/R6/U3-pin-5 summing node that §5-18 step 3 names in those
  words; C58 on U6 pin 5 via `QUAD AMP IN`; C59 on U9 pin 5 via `OSC AMP IN`,
  both 2006C parts with pin 6 to ACOM.

So both plates are at 0 V and what stands across each part is the untrimmed
offset — millivolts. **Recorded as 0 V, not `null`**, on the same principle as
A5's C43: the node was traced and the answer is that there is no working voltage
across it. Leaving them `null` would tell a reader "unknown, could be anything",
which is the opposite of the truth.

The polarity marks corroborate it, and are worth looking at yourself if you doubt
the reasoning. On C56 and C57 **both `+` symbols sit in the gap between the two
capacitors** — the joined positives are a floating midpoint and the outer plates
are the minus ends. That is a non-polar pair, which is exactly what a designer
fits when the DC is about zero and its *sign* is not guaranteed. C58 and C59 are
single polarised parts with `+` toward the multiplier, which says the designer
expected the untrimmed offset to be slightly positive; no offset-null pot is
fitted on any of the three.

**One caveat, and it is why a 10 V part here is not generous.** These sit on the
PLL's control path. §5-18 step 11c says that with the PLL unlocked, TP7 — the
loop-filter output driving these multipliers — goes to **+13 V or −13 V**. A
multiplier driven to its output compliance, or an op-amp that has lost its
virtual ground, could put 10–13 V on one plate. That is a fault condition rather
than service, but it is at or over the rating: **if this board has had a PLL
fault, replace all four regardless of what they measure.**

### A5 C32 — cannot be resolved from the manuals, and stays `null`

It is not drawn anywhere. The search was widened until it was conclusive: no C32
symbol on Rev 9 Ch7 sheets 1, 2 or 3 (p18–20), none on the Rev 9 locator
`5700A-1611` (p17), and none on the 1996 manual's independent copies — Figure 7-5
sheet 3, the Figure 7-5 locator, or the Figure 6-8 locator. Both an OCR
designator sweep and a page-by-page visual search returned nothing.

The parts lists explain why. C32 appears only in the 1996 revision, **appended
after the sorted runs** in its row — as are C30 and C31 in theirs — which is the
signature of a later ECO adding parts to existing table rows without redrawing
the sheets. Rev 9's equivalent row has eleven designators and C32 is not among
them, nor did it move to another row: the adjacent polyester row reads `C33-37`,
not `C32-37`, and its printed quantity of 33 confirms that.

There is even a precedent for the ECO that *did* get drawn: A5 sheet 3 carries a
**hand-lettered** `4.7uF 25V` beside K6/K7, which is C26, inked in among the
machine-drawn 0.1 µF relay-coil snubbers. On that reading C30/C31/C32 are one
more relay-group addition and C32 is a fourth bulk tantalum on +5 RLH — which
would put it at 6.4 V, 26 % of its 25 V rating, exactly where C16, C26 and C44
sit. **That is an inference and it is recorded as one. `appliedV` stays `null`.**

**To resolve it:** look at the board. If C32 is stuffed it will be a 4.7 µF
tantalum physically beside a relay in the 5800/5801 driver area. Failing that,
a post-1996 revision of drawing `5700A-1011` sheet 3 would settle it, and no
manual in this tree contains one.

## The A20 blind spot

This audit was briefed as covering "118 tantalums on 14 boards; A18, A19 and A20
have none". A18 and A19 genuinely have none. **A20 has four**, and they were
invisible for a reason worth spelling out, because it is the kind of thing that
gets a part left in service.

`js/caps.js` classifies a capacitor with

```js
var m = /^CAP,\s*([A-Z]+)/i.exec(item.desc || '');
return m ? m[1].toUpperCase() : null;
```

anchored at the start of the description. A20's parts-list rows are printed
differently from every other board's — `CAPACITOR SMR,CAP,TA,220UF,±20%,10V,7343H`,
with a leading `CAPACITOR` and an `SMR` (surface-mount) qualifier before the
`CAP,` field. The anchor therefore fails, `capType` returns `null` for all 50 of
A20's capacitors, and **`isTantalum` is false for four parts that are tantalums.**
Recap mode's tantalum ranking simply does not contain them.

This is the bug the brief already knew about, with the conclusion attached that
"A20 has no tantalums so it should not affect you". That conclusion is downstream
of the bug: A20 *looks* to have no tantalums **because** of it.

Nothing under `js/` was touched, per the brief. What matters for the bench is
that the underlying data is sound — `Parts.ratedVoltage` is not anchored and
reads all four ratings correctly, and `data/a20.caps.json` already carries all
four with traced nets and good notes:

| Ref | Part | Working V | Margin | Net |
|---|---|---|---|---|
| **C1** | 220 µF **10 V** | 5.2 V | **52 %** | +5 V bulk reservoir for the logic rail, sheet 4 zone C5. The tightest of the four and the one to replace. If it fails short it drops the logic supply for the whole instrument. |
| C17 | 47 µF 16 V | 4.5 V | 28 % | +5 V through CR7 — the NVMOE\* power-up delay that write-protects the EEPROM while the rail comes up (§2-39). Not a voltage risk, but a dried-out C17 shortens the 37 ms hold and puts calibration constants at risk. |
| C100 | 2.2 µF 20 V (Rev 9: 16 V) | 5.2 V | 26 % / 33 % | First part in sheet 1's BYPASS CAPACITORS row, local bulk for U8. |
| C5 | 15 µF 35 V | 5.2 V | 15 % | U1 pin 3, the reset-pulse CT timing capacitor (§2-31, 195 ms). Same story as C17: capacitance matters, voltage does not. |

**Recommended fix**, for whoever picks up `js/caps.js`: drop the `^` anchor and
match the type field wherever it sits — `/\bCAP,\s*([A-Z]+)/i` in place of
`/^CAP,\s*([A-Z]+)/i`. I ran that regex over all 929 capacitors in the datasets
without touching `js/`: **it changes exactly 51 classifications, and every one of
them is `null` → a correct type.** No capacitor that classifies correctly today
is disturbed. The 51 are A20's 50, plus A8 C32 — a 220 pF ceramic printed
`CAPACITOR R05R,CAP,CER,…`, which A8's own file already flags as untraced and
absent from Rev 9. It is a `js/` change and so out of scope here, but it should
not wait: **while it stands, the recap ranking silently omits a whole board.**

## A18 is a gap, not a clean sheet

**A18 Filter/PA Supply has no `data/a18.caps.json` at all.** It has no tantalums,
so it is out of scope for the ratings work above and its absence costs this audit
nothing. But it must not be read as "audited and clean": A18 is the assembly full
of large aluminium reservoirs — 6800 µF, 3300 µF, 2200 µF cans, plus 400 V and
450 V parts in the PA supply — and those are exactly the parts Recap mode ranks
by *capacitance lost* rather than by voltage margin. In the app, A18 currently
shows no capacitor audit at all, which looks identical to a board with nothing
wrong.

**And A18 is the largest of seven such gaps, not the only one.** Every tantalum
in the instrument now has a `caps.json` entry, but **80 aluminium electrolytics
across seven boards do not**, and each of those reads in the app as "rail not
traced":

| Board | Aluminiums with no entry | Notable |
|---|---|---|
| **A18** | **27 of 27** | 6800 µF ×2, 3300 µF ×4, 2200 µF ×2, 47 µF 400 V ×4, 3.3 µF 450 V ×3 |
| **A17** | **26 of 35** | the regulator's own input and output cans, C1–C29 |
| A13 | 8 of 25 | incl. C49, 470 µF 10 V |
| A16 | 7 of 14 | incl. three 3.3 µF **450 V** parts |
| A12 | 6 of 19 | C34/C35/C86/C87, the 47 µF 50 V reservoirs |
| A14 | 4 of 10 | C3/C4 470 µF 16 V; C8/C9 10 µF 63 V on the ±40 S nodes |
| A11 | 2 of 6 | C9, C12 — 10 µF 63 V |

Those are not this audit's job — voltage margin is rarely what kills an
aluminium, and none of them is a tantalum — but they are the difference between
"audited" and "audited for tantalums". A18 first, then A17.

---

## Every tantalum, tightest first

Ordered the way the app's Recap mode ranks: Critical (≥80 %), High (65–80 %),
then the untraced, then Marginal (50–65 %), then OK. **Rows 1–51 are the ones
that matter for a recap**; rows 52–122 are under half of rating on both measures.

"Parts-list row" is the 1996 table row the designator expands out of, so it can
be checked against the manual directly. "Traced?" says `traced` where the net was
followed on the sheet named in the last column and `inferred` where it was not.

| # | Board | Ref | µF | Rated V | Parts-list row (1996 Table 6-x) | Working V | Margin | Worst-case V | Worst-case margin | Traced? | Net | Sheet |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | A16 | C9 | 15 µF | 20 V | `C9,C21` → CAP,TA,15UF,+-20%,20V · stock 807610 | 18 V | 90% | 18.9 V (VR15 +5%) | 95% | traced | SC+ 18Vz | sh2 |
| 2 | A16 | C21 | 15 µF | 20 V | `C9,C21` → CAP,TA,15UF,+-20%,20V · stock 807610 | 15 V | 75% | 15.75 V (VR18 +5%) | 79% | traced | SC- 15Vz | sh2 |
| 3 | A12 | C14 | 4.7 µF | 25 V | `C1-4,C12,C14,C16,C18,C48` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 17 V | 68% | 18.7 V (3601) | 75% | traced | -17S | sh1 |
| 4 | A13 | C99 | 10 µF | 25 V | `C93-99,C106,C107` → CAP,TA,10UF,+-20%,25V · stock 714774 | 17 V | 68% | 18.7 V (3601) | 75% | traced | -17S | sh3 |
| 5 | A17 | C13 | 22 µF | 25 V | `C8,C13` → CAP,TA,22UF,+-20%,25V · stock 845149 | 17 V | 68% | 18.7 V (3601) | 75% | traced | -17S | sh1 |
| 6 | A17 | C68 | 22 µF | 25 V | `C67-70` → CAP,TA,22UF,+-20%,25V · stock 357780 | 17 V | 68% | 18.7 V (3601) | 75% | traced | -17S | sh1 |
| 7 | A5 | C41 | 4.7 µF | 25 V | `C16,C18,C26,C39-44,C32` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 17 V | 68% | 18.7 V (3601) | 75% | traced | -17 S | sh1 |
| 8 | A5 | C42 | 4.7 µF | 25 V | `C16,C18,C26,C39-44,C32` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 17 V | 68% | 18.7 V (3601) | 75% | traced | -17S | sh1 |
| 9 | A6 | C5 | 4.7 µF | 25 V | `C1-8,C49-51` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 17.865 V | 71% | 18.7 V (3601) | 75% | traced | -17 S | sh1 |
| 10 | A6 | C6 | 4.7 µF | 25 V | `C1-8,C49-51` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 17.865 V | 71% | 18.7 V (3601) | 75% | traced | -17S | sh1 |
| 11 | A7 | C7 | 4.7 µF | 25 V | `C6,C7,C21-24,C37,C38,C40,C43,C52,C53,C60,C61` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 17.865 V | 71% | 18.7 V (3601) | 75% | traced | -17 S | sh2 |
| 12 | A7 | C24 | 4.7 µF | 25 V | `C6,C7,C21-24,C37,C38,C40,C43,C52,C53,C60,C61` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 17.865 V | 71% | 18.7 V (3601) | 75% | traced | -17 S | sh3 |
| 13 | A7 | C38 | 4.7 µF | 25 V | `C6,C7,C21-24,C37,C38,C40,C43,C52,C53,C60,C61` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 17.865 V | 71% | 18.7 V (3601) | 75% | traced | -17 LH | sh4 |
| 14 | A7 | C53 | 4.7 µF | 25 V | `C6,C7,C21-24,C37,C38,C40,C43,C52,C53,C60,C61` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 17.865 V | 71% | 18.7 V (3601) | 75% | traced | -17 LH | sh3 |
| 15 | A7 | C61 | 4.7 µF | 25 V | `C6,C7,C21-24,C37,C38,C40,C43,C52,C53,C60,C61` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 17.865 V | 71% | 18.7 V (3601) | 75% | traced | -17 S | sh3 |
| 16 | A12 | C12 | 4.7 µF | 25 V | `C1-4,C12,C14,C16,C18,C48` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 17 V | 68% | 18 V (3600) | 72% | traced | +17S | sh1 |
| 17 | A13 | C98 | 10 µF | 25 V | `C93-99,C106,C107` → CAP,TA,10UF,+-20%,25V · stock 714774 | 17 V | 68% | 18 V (3600) | 72% | traced | +17S | sh3 |
| 18 | A17 | C8 | 22 µF | 25 V | `C8,C13` → CAP,TA,22UF,+-20%,25V · stock 845149 | 17 V | 68% | 18 V (3600) | 72% | traced | +17S | sh1 |
| 19 | A17 | C67 | 22 µF | 25 V | `C67-70` → CAP,TA,22UF,+-20%,25V · stock 357780 | 17 V | 68% | 18 V (3600) | 72% | traced | +17S | sh1 |
| 20 | A4 | C1 | 10 µF | 35 V | `C1,C4` → CAP,TA,10UF,+-20%,35V · stock 816512 | 24 V | 69% | 25.2 V (T2-2) | 72% | traced | +12V FAN to -12V FAN (across fan 1, ahead of R2) | sh3 |
| 21 | A4 | C4 | 10 µF | 35 V | `C1,C4` → CAP,TA,10UF,+-20%,35V · stock 816512 | 24 V | 69% | 25.2 V (T2-2) | 72% | traced | +12V FAN to -12V FAN (across fan 2, ahead of R3) | — |
| 22 | A5 | C39 | 4.7 µF | 25 V | `C16,C18,C26,C39-44,C32` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 17 V | 68% | 18 V (3600) | 72% | traced | +17 S | sh1 |
| 23 | A5 | C40 | 4.7 µF | 25 V | `C16,C18,C26,C39-44,C32` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 17 V | 68% | 18 V (3600) | 72% | traced | +17S | sh1 |
| 24 | A6 | C7 | 4.7 µF | 25 V | `C1-8,C49-51` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 17.475 V | 70% | 18 V (3600) | 72% | traced | +17 S | sh1 |
| 25 | A6 | C8 | 4.7 µF | 25 V | `C1-8,C49-51` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 17.475 V | 70% | 18 V (3600) | 72% | traced | +17S | sh1 |
| 26 | A7 | C6 | 4.7 µF | 25 V | `C6,C7,C21-24,C37,C38,C40,C43,C52,C53,C60,C61` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 17.475 V | 70% | 18 V (3600) | 72% | traced | +17 S | sh2 |
| 27 | A7 | C23 | 4.7 µF | 25 V | `C6,C7,C21-24,C37,C38,C40,C43,C52,C53,C60,C61` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 17.475 V | 70% | 18 V (3600) | 72% | traced | +17 S | sh3 |
| 28 | A7 | C52 | 4.7 µF | 25 V | `C6,C7,C21-24,C37,C38,C40,C43,C52,C53,C60,C61` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 17.475 V | 70% | 18 V (3600) | 72% | traced | +17 LH | sh3 |
| 29 | A7 | C60 | 4.7 µF | 25 V | `C6,C7,C21-24,C37,C38,C40,C43,C52,C53,C60,C61` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 17.475 V | 70% | 18 V (3600) | 72% | traced | +17 S | sh3 |
| 30 | A9 | C18 | 4.7 µF | 25 V | `C18,C33` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 17 V | 68% | 18 V (3600) | 72% | traced | +17 S switched by Q5 (U6 supply, ahead of L2) | sh3 |
| 31 | A5 | C32 | 4.7 µF | 25 V | `C16,C18,C26,C39-44,C32` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | **null** | — | — | — | inferred | — | sh3 |
| 32 | A14 | C13 | 22 µF | 10 V | `C11-13` → CAP,TA,22UF,+-20%,10V · stock 658971 | 6.4 V | 64% | 6.4 V (T2-10) | 64% | traced | +5RLH | sh1 |
| 33 | A15 | C34 | 22 µF | 10 V | `C34` → CAP,TA,22UF,+-20%,10V · stock 658971 | 6.4 V | 64% | 6.4 V (T2-10) | 64% | traced | +5 RLH | — |
| 34 | A12 | C3 | 4.7 µF | 25 V | `C1-4,C12,C14,C16,C18,C48` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 15 V | 60% | 15.8 V (3602/3612) | 63% | traced | +15 OSC | sh1 |
| 35 | A12 | C4 | 4.7 µF | 25 V | `C1-4,C12,C14,C16,C18,C48` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 15 V | 60% | 15.8 V (3603/3613) | 63% | traced | -15 OSC | sh1 |
| 36 | A13 | C96 | 10 µF | 25 V | `C93-99,C106,C107` → CAP,TA,10UF,+-20%,25V · stock 714774 | 15 V | 60% | 15.8 V (3602/3612) | 63% | traced | +15S | sh3 |
| 37 | A13 | C97 | 10 µF | 25 V | `C93-99,C106,C107` → CAP,TA,10UF,+-20%,25V · stock 714774 | 15 V | 60% | 15.8 V (3603/3613) | 63% | traced | -15S | sh3 |
| 38 | A16 | C65 | 4.7 µF | 25 V | `C65,C67` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 15 V | 60% | 15.8 V (3602/3612) | 63% | traced | +15 OSC | sh2 |
| 39 | A16 | C67 | 4.7 µF | 25 V | `C65,C67` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 15 V | 60% | 15.8 V (3603/3613) | 63% | traced | -15 OSC | sh2 |
| 40 | A12 | C48 | 4.7 µF | 25 V | `C1-4,C12,C14,C16,C18,C48` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 15 V | 60% | — | — | traced | VREF at U30 pin 3, through R32 (120 ohm) — DC SENSE BUFFER | sh2 |
| 41 | A20 | C1 | 220 µF | 10 V | `C1` → CAPACITOR SMR,CAP,TA,220UF,+-20%,10V,7343H · stock 106021 | 5.2 V | 52% | 5.46 V (T2-2) | 55% | traced | +5V | sh4 |
| 42 | A14 | C11 | 22 µF | 10 V | `C11-13` → CAP,TA,22UF,+-20%,10V · stock 658971 | 5.1 V | 51% | 5.4 V (T2-10) | 54% | traced | +5LH | sh1 |
| 43 | A17 | C55 | 10 µF | 10 V | `C55,C58` → CAP,TA,10UF,+-20%,10V · stock 714766 | 5.1 V | 51% | 5.4 V (T2-10) | 54% | traced | U60 (7705A) CT timing pin to GND2 | sh2 |
| 44 | A17 | C57 | 47 µF | 10 V | `C57` → CAP,TA,47UF,+-20%,10V · stock 733246 | 5.1 V | 51% | 5.4 V (T2-10) | 54% | traced | +5V (guarded digital), derived on this board from +5 LH through L51 | sh2 |
| 45 | A17 | C58 | 10 µF | 10 V | `C55,C58` → CAP,TA,10UF,+-20%,10V · stock 714766 | 5.1 V | 51% | 5.4 V (T2-10) | 54% | traced | +5V (guarded digital) bypass bank, to GND2 | sh2 |
| 46 | A9 | C36 | 47 µF | 10 V | `C36` → CAP,TA,47UF,+-20%,10V · stock 733246 | 5.1 V | 51% | 5.4 V (T2-10) | 54% | traced | +5 LH (after L6) | sh4 |
| 47 | A9 | C9 | 2.2 µF | 35 V | `C7,C9,C22,C23` → CAP,TA,2.2UF,+-10%,35V · stock 697433 | 17 V | 49% | 18.7 V (3601) | 53% | traced | -17 (local, after L8 and R15) | sh2 |
| 48 | A14 | C12 | 22 µF | 10 V | `C11-13` → CAP,TA,22UF,+-20%,10V · stock 658971 | 5 V | 50% | 5.3 V (T2-10) | 53% | traced | -5LH | sh1 |
| 49 | A9 | C7 | 2.2 µF | 35 V | `C7,C9,C22,C23` → CAP,TA,2.2UF,+-10%,35V · stock 697433 | 17 V | 49% | 18 V (3600) | 51% | traced | +17 (local, after L7 and R14) | sh2 |
| 50 | A9 | C19 | 10 µF | 35 V | `C19,C24,C25` → CAP,TA,10UF,+-20%,35V · stock 816512 | 17 V | 49% | 18 V (3600) | 51% | traced | +17 S switched by Q5, after L2 (U6 +VIN through R25) | sh3 |
| 51 | A6 | C50 | 4.7 µF | 25 V | `C1-8,C49-51` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 12.4 V | 50% | — | — | traced | +12 | sh1 |
| 52 | A10 | C3 | 10 µF | 35 V | `C3,C4` → CAP,TA,10UF,+-20%,35V · stock 816512 | 17 V | 49% | — | — | traced | U1 positive supply node (+17 S through VR1) | sh1 |
| 53 | A10 | C4 | 10 µF | 35 V | `C3,C4` → CAP,TA,10UF,+-20%,35V · stock 816512 | 17 V | 49% | — | — | traced | U1 negative supply node (-17 S through R5) | sh1 |
| 54 | A14 | C6 | 10 µF | 35 V | `C6,C7` → CAP,TA,10UF,+-20%,35V · stock 816512 | 15 V | 43% | 15.8 V (3602/3612) | 45% | traced | +15S | sh1 |
| 55 | A14 | C7 | 10 µF | 35 V | `C6,C7` → CAP,TA,10UF,+-20%,35V · stock 816512 | 15 V | 43% | 15.8 V (3603/3613) | 45% | traced | -15S | sh1 |
| 56 | A15 | C30 | 10 µF | 35 V | `C30,C31,C37,C39` → CAP,TA,10UF,+-20%,35V · stock 816512 | 15 V | 43% | 15.8 V (3602/3612) | 45% | traced | +15S | — |
| 57 | A15 | C31 | 10 µF | 35 V | `C30,C31,C37,C39` → CAP,TA,10UF,+-20%,35V · stock 816512 | 15 V | 43% | 15.8 V (3603/3613) | 45% | traced | -15S | — |
| 58 | A12 | C40 | 10 µF | 25 V | `C40,C41` → CAP,TA,10UF,+-20%,25V · stock 714774 | 10.7 V | 43% | — | — | traced | +15A minus VR3 5.1 V | sh1 |
| 59 | A12 | C41 | 10 µF | 25 V | `C40,C41` → CAP,TA,10UF,+-20%,25V · stock 714774 | 10.6 V | 42% | — | — | traced | -15A plus R17/R19 drop | sh1 |
| 60 | A12 | C1 | 4.7 µF | 25 V | `C1-4,C12,C14,C16,C18,C48` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 10 V | 40% | 10.5 V (zener +5%) | 42% | traced | VR1 10 V zener | sh1 |
| 61 | A12 | C2 | 4.7 µF | 25 V | `C1-4,C12,C14,C16,C18,C48` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 10 V | 40% | 10.5 V (zener +5%) | 42% | traced | VR2 10 V zener | sh1 |
| 62 | A6 | C51 | 4.7 µF | 25 V | `C1-8,C49-51` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 10.4 V | 42% | — | — | traced | -9.5 | sh1 |
| 63 | A14 | C18 | 1 µF | 35 V | `C18` → CAP,TA,1UF,+-20%,35V · stock 697417 | 13.5 V | 39% | — | — | traced | AMPLITUDE (U2D TL084 output) | sh2 |
| 64 | A13 | C108 | 4.7 µF | 25 V | `C60,C61,C108,C109` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 9.1 V | 36% | 9.56 V (zener +5%) | 38% | traced | VR3 9.1 V zener | sh2 |
| 65 | A13 | C109 | 4.7 µF | 25 V | `C60,C61,C108,C109` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 9.1 V | 36% | 9.56 V (zener +5%) | 38% | traced | VR4 9.1 V zener | sh2 |
| 66 | A11 | C30 | 1.5 µF | 50 V | `C30,C31` → CAP,TA,1.5UF,+-20%,50V,6032 · stock 929302 | 17 V | 34% | 18 V (3600) | 36% | traced | +17SB | sh5 |
| 67 | A11 | C31 | 1.5 µF | 50 V | `C30,C31` → CAP,TA,1.5UF,+-20%,50V,6032 · stock 929302 | 17 V | 34% | 18 V (3600) | 36% | traced | +17SB | sh5 |
| 68 | A20 | C17 | 47 µF | 16 V | `C17` → CAPACITOR SMR,CAP,TA,47UF,+-20%,16V,7343 · stock 644994 | 4.5 V | 28% | 5.46 V (T2-2) | 34% | traced | +5V through CR7 (NVMOE* power-up delay) | sh2 |
| 69 | A8 | C22 | 15 µF | 20 V | `C22` → CAP,TA,15UF,+-20%,20V · stock 807610 | 6.4 V | 32% | 6.4 V (T2-10) | 32% | traced | +5 RLH | sh3 |
| 70 | A16 | C25 | 1 µF | 35 V | `C10,C25` → CAP,TA,1UF,+-20%,35V · stock 697417 | 10 V | 29% | 10.5 V (zener +5%) | 30% | traced | VR32 10 V zener | sh1 |
| 71 | A9 | C22 | 2.2 µF | 35 V | `C7,C9,C22,C23` → CAP,TA,2.2UF,+-10%,35V · stock 697433 | 10 V | 29% | — | — | traced | T1 secondary, positive rectified (CR1 / CR9), ahead of R43 | sh3 |
| 72 | A9 | C23 | 2.2 µF | 35 V | `C7,C9,C22,C23` → CAP,TA,2.2UF,+-10%,35V · stock 697433 | 10 V | 29% | — | — | traced | T1 secondary, negative rectified (CR2 / CR10), ahead of R44 | sh3 |
| 73 | A20 | C100 | 2.2 µF | 20 V | `C100` → CAPACITOR SMR,CAP,TA,2.2UF,+-20%,20V,3528 · stock 854760 | 5.2 V | 26% | 5.46 V (T2-2) | 27% | traced | +5V | sh1 |
| 74 | A13 | C60 | 4.7 µF | 25 V | `C60,C61,C108,C109` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 6.5 V | 26% | — | — | traced | Error integrator feedback (U18 LF356 / TP6) | sh1 |
| 75 | A13 | C61 | 4.7 µF | 25 V | `C60,C61,C108,C109` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 6.5 V | 26% | — | — | traced | Error integrator feedback (U18 LF356 / TP6) | — |
| 76 | A10 | C6 | 4.7 µF | 25 V | `C6` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 6.4 V | 26% | 6.4 V (T2-10) | 26% | traced | +5 RLH | sh2 |
| 77 | A13 | C93 | 10 µF | 25 V | `C93-99,C106,C107` → CAP,TA,10UF,+-20%,25V · stock 714774 | 6.4 V | 26% | 6.4 V (T2-10) | 26% | traced | +5RLH | sh3 |
| 78 | A17 | C70 | 22 µF | 25 V | `C67-70` → CAP,TA,22UF,+-20%,25V · stock 357780 | 6.4 V | 26% | 6.4 V (T2-10) | 26% | traced | +5RLH | sh1 |
| 79 | A5 | C16 | 4.7 µF | 25 V | `C16,C18,C26,C39-44,C32` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 6.4 V | 26% | — | — | traced | +SRLH | sh3 |
| 80 | A5 | C26 | 4.7 µF | 25 V | `C16,C18,C26,C39-44,C32` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 6.4 V | 26% | 6.4 V (T2-10) | 26% | traced | +5RLH (attenuator relay coil bank) | sh3 |
| 81 | A5 | C44 | 4.7 µF | 25 V | `C16,C18,C26,C39-44,C32` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 6.4 V | 26% | 6.4 V (T2-10) | 26% | traced | +5 RLH | sh3 |
| 82 | A9 | C33 | 4.7 µF | 25 V | `C18,C33` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 6.4 V | 26% | 6.4 V (T2-10) | 26% | traced | +5 RLH (after L5) | sh4 |
| 83 | A9 | C24 | 10 µF | 35 V | `C19,C24,C25` → CAP,TA,10UF,+-20%,35V · stock 816512 | 8.2 V | 23% | — | — | traced | +8A | sh3 |
| 84 | A9 | C25 | 10 µF | 35 V | `C19,C24,C25` → CAP,TA,10UF,+-20%,35V · stock 816512 | 8.2 V | 23% | — | — | traced | -8A | sh3 |
| 85 | A12 | C22 | 330 µF | 3 V | `C22,C25` → CAP,TA,330UF,+-20%,3V · stock 385963 | 0.7 V | 23% | — | — | traced | Buffer amp output coupling (U3 pin 6 / TP4) | sh1 |
| 86 | A12 | C25 | 330 µF | 3 V | `C22,C25` → CAP,TA,330UF,+-20%,3V · stock 385963 | 0.7 V | 23% | — | — | traced | Buffer amp output coupling (U3 pin 6 / TP4) | sh1 |
| 87 | A12 | C16 | 4.7 µF | 25 V | `C1-4,C12,C14,C16,C18,C48` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 5.1 V | 20% | 5.4 V (T2-10) | 22% | traced | +5LH | sh3 |
| 88 | A13 | C94 | 10 µF | 25 V | `C93-99,C106,C107` → CAP,TA,10UF,+-20%,25V · stock 714774 | 5.1 V | 20% | 5.4 V (T2-10) | 22% | traced | +5LH | sh3 |
| 89 | A13 | C106 | 10 µF | 25 V | `C93-99,C106,C107` → CAP,TA,10UF,+-20%,25V · stock 714774 | 5.1 V | 20% | 5.4 V (T2-10) | 22% | traced | +5S | — |
| 90 | A17 | C69 | 22 µF | 25 V | `C67-70` → CAP,TA,22UF,+-20%,25V · stock 357780 | 5.1 V | 20% | 5.4 V (T2-10) | 22% | traced | +5LH | sh1 |
| 91 | A5 | C18 | 4.7 µF | 25 V | `C16,C18,C26,C39-44,C32` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 5.1 V | 20% | 5.4 V (T2-10) | 22% | traced | +SLH | sh3 |
| 92 | A5 | C21 | 4.7 µF | 25 V | `C17,C21` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 5.1 V | 20% | 5.4 V (T2-10) | 22% | traced | +5 LH | sh3 |
| 93 | A6 | C3 | 4.7 µF | 25 V | `C1-8,C49-51` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 5.1 V | 20% | 5.4 V (T2-10) | 22% | traced | +5 LH | sh1 |
| 94 | A6 | C4 | 4.7 µF | 25 V | `C1-8,C49-51` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 5.1 V | 20% | 5.4 V (T2-10) | 22% | traced | +5LH | sh1 |
| 95 | A7 | C21 | 4.7 µF | 25 V | `C6,C7,C21-24,C37,C38,C40,C43,C52,C53,C60,C61` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 5.1 V | 20% | 5.4 V (T2-10) | 22% | traced | +5 LH | sh3 |
| 96 | A7 | C40 | 4.7 µF | 25 V | `C6,C7,C21-24,C37,C38,C40,C43,C52,C53,C60,C61` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 5.1 V | 20% | 5.4 V (T2-10) | 22% | traced | +5 LH | sh4 |
| 97 | A7 | C43 | 4.7 µF | 25 V | `C6,C7,C21-24,C37,C38,C40,C43,C52,C53,C60,C61` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 5.1 V | 20% | 5.4 V (T2-10) | 22% | traced | +5 LH | sh4 |
| 98 | A12 | C18 | 4.7 µF | 25 V | `C1-4,C12,C14,C16,C18,C48` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 5 V | 20% | 5.3 V (T2-10) | 21% | traced | -5LH | sh3 |
| 99 | A13 | C95 | 10 µF | 25 V | `C93-99,C106,C107` → CAP,TA,10UF,+-20%,25V · stock 714774 | 5.3 V | 21% | 5.3 V (T2-10) | 21% | traced | -5 LH | sh3 |
| 100 | A13 | C107 | 10 µF | 25 V | `C93-99,C106,C107` → CAP,TA,10UF,+-20%,25V · stock 714774 | 5.3 V | 21% | 5.3 V (T2-10) | 21% | traced | -5S | — |
| 101 | A5 | C17 | 4.7 µF | 25 V | `C17,C21` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 5.3 V | 21% | 5.3 V (T2-10) | 21% | traced | -SLH | sh3 |
| 102 | A6 | C1 | 4.7 µF | 25 V | `C1-8,C49-51` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 5 V | 20% | 5.3 V (T2-10) | 21% | traced | -5 LH | sh1 |
| 103 | A6 | C2 | 4.7 µF | 25 V | `C1-8,C49-51` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 5 V | 20% | 5.3 V (T2-10) | 21% | traced | -5LH | sh1 |
| 104 | A7 | C22 | 4.7 µF | 25 V | `C6,C7,C21-24,C37,C38,C40,C43,C52,C53,C60,C61` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 5 V | 20% | 5.3 V (T2-10) | 21% | traced | -5 LH | sh3 |
| 105 | A7 | C37 | 4.7 µF | 25 V | `C6,C7,C21-24,C37,C38,C40,C43,C52,C53,C60,C61` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 5.25 V | 21% | — | — | traced | VCO supply, U19 pin 8 (-5.25 V) | sh4 |
| 106 | A6 | C49 | 4.7 µF | 25 V | `C1-8,C49-51` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 5 V | 20% | — | — | traced | -5F | sh1 |
| 107 | A7 | C39 | 22 µF | 25 V | `C39` → CAP,TA,22UF,+-20%,25V · stock 845149 | 5 V | 20% | — | — | traced | Hi-res output coupling, Q16 emitter to U18D pin 7 | sh4 |
| 108 | A15 | C37 | 10 µF | 35 V | `C30,C31,C37,C39` → CAP,TA,10UF,+-20%,35V · stock 816512 | 5.83 V | 17% | — | — | traced | VI+ | — |
| 109 | A15 | C39 | 10 µF | 35 V | `C30,C31,C37,C39` → CAP,TA,10UF,+-20%,35V · stock 816512 | 5.83 V | 17% | — | — | traced | VI- | — |
| 110 | A20 | C5 | 15 µF | 35 V | `C5` → CAPACITOR SMR,CAP,TA,15UF,+-20%,35V,7343 · stock 690252 | 5.2 V | 15% | 5.46 V (T2-2) | 16% | traced | +5V (U1 CT timing pin) | sh1 |
| 111 | A16 | C10 | 1 µF | 35 V | `C10,C25` → CAP,TA,1UF,+-20%,35V · stock 697417 | 4.6 V | 13% | — | — | traced | Q7 collector-emitter (bias adjust) | sh2 |
| 112 | A7 | C15 | 2.2 µF | 16 V | `C15` → CAP,TA,2.2UF,+-20%,16V · stock 706804 | 0.8 V | 5% | — | — | traced | Across Q1 (TIP32) emitter-base — +8 RLH emitter stub to HR2 pin 6 | sh2 |
| 113 | A11 | C19 | 2.2 µF | 35 V | `C19,C20` → CAP,TA,2.2UF,+-10%,35V · stock 697433 | 0.8 V | 2% | — | — | traced | Across Q2 (TIP32) emitter-base — +5FR1R emitter rail to heater hybrid pin 6 | sh1 |
| 114 | A11 | C20 | 2.2 µF | 35 V | `C19,C20` → CAP,TA,2.2UF,+-10%,35V · stock 697433 | 0.8 V | 2% | — | — | traced | Across Q3 (TIP32) emitter-base — +5FR1R emitter rail to heater hybrid pin 6 | — |
| 115 | A15 | C14 | 2.2 µF | 35 V | `C14,C19` → CAP,TA,2.2UF,+-10%,35V · stock 697433 | 0.8 V | 2% | — | — | traced | Q8 TIP32A emitter-base | sh1 |
| 116 | A15 | C19 | 2.2 µF | 35 V | `C14,C19` → CAP,TA,2.2UF,+-10%,35V · stock 697433 | 0.8 V | 2% | — | — | traced | Q18 TIP32A emitter-base | sh2 |
| 117 | A16 | C45 | 2.2 µF | 35 V | `C45` → CAP,TA,2.2UF,+-10%,35V · stock 697433 | 0.8 V | 2% | — | — | traced | Across Q38 (TIP32) emitter-base — +8RLH emitter stub to heater hybrid pin 6 | sh3 |
| 118 | A13 | C56 | 22 µF | 10 V | `C56-59` → CAP,TA,22UF,+-20%,10V · stock 658971 | 0 V | 0% | — | — | traced | U16 MC1494L pin 14 (OUT) to the summing-amp virtual ground — anti-series with C57 | sh1 |
| 119 | A13 | C57 | 22 µF | 10 V | `C56-59` → CAP,TA,22UF,+-20%,10V · stock 658971 | 0 V | 0% | — | — | traced | U16 MC1494L pin 14 (OUT) to the summing-amp virtual ground — anti-series with C56 | — |
| 120 | A13 | C58 | 22 µF | 10 V | `C56-59` → CAP,TA,22UF,+-20%,10V · stock 658971 | 0 V | 0% | — | — | traced | U19 MC1494L pin 14 (OUT) through R47 to the quadrature amp's virtual ground | sh2 |
| 121 | A13 | C59 | 22 µF | 10 V | `C56-59` → CAP,TA,22UF,+-20%,10V · stock 658971 | 0 V | 0% | — | — | traced | U15 MC1494L pin 14 (OUT) through R80 to the oscillator amp's virtual ground | sh2 |
| 122 | A5 | C43 | 4.7 µF | 25 V | `C16,C18,C26,C39-44,C32` → CAP,TA,4.7UF,+-20%,25V · stock 807644 | 0 V | 0% | — | — | traced | RLHCOM | sh3 |
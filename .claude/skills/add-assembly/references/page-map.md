# Where each assembly lives in the manuals

Three PDFs, from two revisions of the manual, and the difference matters:

- `Manuals/5700A_5720A_Service_Manual_1996_Rev1_2002.pdf` — has a **real text
  layer**. Source for parts lists, supply tables, theory and troubleshooting
  sections. Read it with `pdftotext -layout`; never OCR it.
- `Schematics_and_Parts_Lists/5700A_Rev9_ServiceManual_Ch7_Schematic_Diagrams.pdf`
  — scanned at 400 dpi. Source for the component locator drawing and the
  schematic sheets. Higher effective resolution than the duplicate locator
  figures in Chapter 6, so prefer it.
- `Schematics_and_Parts_Lists/5700A_Rev9_ServiceManual_Ch6_Replaceable_Parts_List.pdf`
  — scanned. Only worth OCR-ing for the two columns the 1996 list lacks:
  manufacturer supply code and manufacturer part number.

## The table

**Drawing** and **Sheets** are page numbers in the Ch7 PDF, exact.
**1996 table** is the parts list to parse from the text layer.
**Rev 9 Ch6 page** is approximate — see the caveat below.

| Assembly | Name | Drawing | Sheets | 1996 table | Rev 9 Ch6 page |
|---|---|---|---|---|---|
| **A1** | Keyboard Assembly | 1 | 2 | 6-2 | ~15 |
| **A2** | Front Panel PCA | 3 | 4–7 | 6-3 | ~17 |
| **A3** | Analog Motherboard PCA | 8 | 9–12 | 6-4 | ~20 |
| **A4** | Digital Motherboard PCA | 13 | 14–16 | 6-5 | **20** |
| **A5** | Wideband Output PCA (Option -03) | 17 | 18–20 | 6-6 | **22–24** |
| **A6** | Wideband Oscillator PCA (Option -03) | 21 | 22–24 | 6-7 | **26–28** |
| **A7** | Current/High-Resolution Oscillator PCA | 25 | 26–29 | 6-8 | ~32 |
| **A8** | Switch Matrix PCA | 30 | 31–35 | 6-9 | ~36 |
| **A9** | Ohms Cal PCA | 36 | 37–40 | 6-10 | ~39 |
| **A10** | Ohms Main PCA | 41 | 42–45 | 6-11 | ~42 |
| **A11** | DAC PCA | 46 | 47–52 | 6-12 | ~44 |
| **A11A1** | DAC Filter SIP PCA | 53 | — | 6-13 | ~49 |
| **A11A2** | DAC Buffered Reference SIP PCA | 54 | — | 6-14 | ~51 |
| **A12** | Oscillator Control PCA | **55** | **56–58** | 6-15 | **51–53** |
| **A13** | Oscillator Output PCA | **59** | **60–62** | 6-16 | ~57 |
| **A13A1** | Oscillator Wideband SMD PCA | 63 | 64 | 6-17 | ~61 |
| **A14** | High Voltage Control PCA | **65** | **66–69** | 6-18 | **61–62** |
| **A15** | High Voltage/High Current PCA | 70 | 71–72 | 6-19 | **64–66** |
| **A16** | Power Amplifier PCA | 73 | 74–76 | 6-20 | ~69 |
| **A16A1** | Power Amplifier Digital Control SIP PCA | 77 | 78 | 6-21 | ~73 |
| **A17** | Regulator/Guard Crossing PCA | 79 | 80–81 | 6-22 | **75–76** |
| **A18** | Filter/PA Supply PCA | 82 | 83–84 | 6-23 | **78–80** |
| **A19** | Digital Power Supply PCA | 85 | 86 | 6-24 | ~82 |
| **A20** | CPU PCA | 87 | **88–92** | 6-25 **and 6-26** | **85–86** |
| **A21** | Rear Panel PCA | 93 | 94–95 | 6-27 | ~88 |

## How this was derived, and how far to trust it

The 1996 manual's list of figures gives each assembly's *manual* page (A18 is
figure 7-22 on page 7-84). In the Rev 9 Ch7 PDF the same figure is on PDF page
82, so **PDF page = manual page − 2**, and the sheets follow until the next
figure begins.

That offset was checked against the printed caption at five points spread across
the document — pages 8 (A3), 46 (A11), 79 (A17), 82 (A18) and 85 (A19) — and
held exactly at every one. Treat the Drawing column as reliable.

**The Sheets column is the one that drifts, because it was derived by assuming a
sheet count rather than by reading.** A12 was listed as 56–59 and is really
56–58: 5700A-1050 prints "(1 of 3)", "(2 of 3)", "(3 of 3)", and page 59 is
already A13's component locator, 5700A-1651. That one error pushed A13's whole
row down by one as well — A13 is drawing 59, sheets 60–62, not drawing 60,
sheets 61–62. So **confirm both ends of the range**, not only the start: render
the first page after the range and check that its drawing number is a `16xx`.

**Do not trust the printed caption on the locator page.** Page 55 reads
"Figure 7-14. A12 Oscillator Control PCA (cont)" even though it is the *first*
page of the figure — the manual's own typo. The title-block drawing number is
decisive and never lies: `5700A-16xx` is a component locator, `5700A-10xx` is a
schematic sheet. The number sits inside the frame near the bottom right, above
the caption, so a crop that catches the caption has cropped too low.

The Ch6 column is a different story. It assumes **Rev 9 PDF page = 1996 manual
page + 3**, which holds for A18 (6-75 → 78) and A19 (6-79 → 82) but drifts
elsewhere: A11 predicts 44, and page 44 is already the *continuation* of that
table. The two revisions gained and lost parts, so their pagination diverges.
Bold entries have been confirmed by reading the page. Use the rest as a starting
point and confirm the same way — A14's estimate of ~63 was wrong by two pages,
and page 63 is the Chapter 6 duplicate of the locator drawing, which looks
enough like the right place to be believed for a while. A15's estimate of ~66
was wrong the other way: Table 6-19 starts on 64 and runs to 66, and 66 is its
last page rather than its first, so a reader who started there would have got
two thirds of the manufacturer columns and no warning.

**That last-page failure is the common one.** A5's estimate of ~24 and A6's of
~28 were each the final page of a three-page table that really starts at 22 and
26. A4's ~22 was worse than wrong: A4's table is the single page 20, and page 22
is already *A5's* table, so the estimate would have parsed one board's parts as
another's without anything looking amiss. Confirm the start by reading the
heading, then walk forward to the end.

**Two more things the Ch6 scans do that nothing warns you about.** A20's table
runs 85–86 and pages **87–88 are a duplicate scan of them** — same rows, same
stock numbers, differing only in OCR noise; feeding both joins every row against
itself. And the manual mis-numbers A20's continuation page as **Table 6-26**
where A19's and A21's continuations reuse their own numbers, so naming only
6-25 silently loses fourteen rows including the SRAM, the DUART, the RTC and the
battery holder. `parts_table` takes a list for exactly this.

**Match the caption's typos.** `parse_parts_1996` finds the table by its printed
heading, and two of them are misspelled in the 1996 manual: A6's reads "A6
Wideband **Ocillator** PCA" on all three pages, and §5-5's opening sentence calls
A6 "the Wideband Oscillator assembly (**A5**)" — the heading is right there but a
grep for A5 will find it. Copy the heading as printed, typo and all, or the table
is simply not found.

To confirm a page, render its title band and read it. `pdftoppm` zero-pads the
page number to the width of the document's last page, so Chapter 7 gives
`p-082.png` and Chapter 6 gives `p-62.png` — glob for the output, do not guess
its name.

```bash
pdftoppm -f 82 -l 82 -r 45 -png -gray \
  Schematics_and_Parts_Lists/5700A_Rev9_ServiceManual_Ch6_Replaceable_Parts_List.pdf /tmp/p
magick /tmp/p-82.png -crop 100%x14%+0+0 +repage -resize 200% /tmp/title.png
```

Then walk forward until the table ends — a parts list runs over two to four
pages, and `build_data.py` wants all of them.

Do the same check for the drawing before extracting assets. One render is
cheaper than discovering at the coordinate stage that you have been working on
the wrong board.

## Supply tables for the power assemblies

Test point expectations come from a supply table, and only some assemblies have
one. These share a column layout — signal name, test point, nominal, tolerance,
current limit, rated output — so the `testpoints.json` schema carries over:

| Assembly | Table | What it lists |
|---|---|---|
| A18 Filter/PA Supply | 2-8, 2-9 | unregulated and regulated supplies |
| A19 Digital Power Supply | 2-2 | supplies generated by the digital supply (TP2, TP5, TP8, TP10, TP12, TP13) |
| A17 Regulator/Guard Crossing | 2-10 | regulated outputs — but the table is missing its +15 S row and loses the sign on −15 S, so read §2-71…§2-76 alongside it |

For an assembly with no supply table, the test points still have signal names —
read them from the legend box on the schematic sheet — but there may be no
published expected value. Say so in the data rather than inventing one: a test
point with a name and no nominal is honest and still useful for locating.

## Troubleshooting: not every board has a procedure

Chapter 5's component-level sections run from **5-4** (A5) to **5-23** (A18) and
cover only fourteen assemblies. A17, A19, A20 and A21 have none. Check before
you write a `procedure` entry into `build_data.py`'s config: `grep -nE '^\s*5-[0-9]+\.\s+[A-Z]'`
over the text layer lists them all in one go.

Where there is no section, the **§5-2 diagnostic fault codes are the published
procedure** — they name the test point, the COM, the acceptance band and, most
usefully, what an *in*-tolerance reading means. A17's are the 3600 series. They
are prose keyed by code rather than numbered steps, so they are curated into
`data/<asm>.reference.json` as `faultCodes` rather than parsed, and the app
already has a panel for them. `assemble.py` takes `PROCEDURES[asm]` as optional
and emits no procedure at all rather than an empty shell.

Circuit descriptions are in Chapter 2 — grep the text layer for the assembly
designator to find its sections.

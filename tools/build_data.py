#!/usr/bin/env python3
"""
build_data.py — extract the non-geometric dataset for one assembly.

Pulls together four sources and writes .build/<asm>/extracted.json plus a
review report listing everything a human still needs to look at:

  1. Parts list, 1996 Series II service manual (real PDF text layer, exact).
     Authority for designators, descriptions, Fluke stock numbers, quantities.
  2. Parts list, Rev 9 service manual chapter 6 (400 dpi scan, OCR).
     Only source for manufacturer supply code and manufacturer part number.
     Also the revision that matches the board drawing and the REV H photo, so
     where the two lists disagree the Rev 9 entry is recorded as "as built".
  3. Tables 2-8 / 2-9 (text layer) — test point nominal, tolerance, ripple,
     rated output and the COM reference point for every supply rail.
  4. Section 5-23 (text layer) — the 14-step ±PA troubleshooting procedure.

The two parts lists are joined on Fluke stock number, which appears in both and
survives OCR cleanly (an isolated 6-digit field), so the join validates itself.
Rows that fail to join fall back to a designator match and are reported rather
than silently merged.

Usage: tools/build_data.py [assembly-id]
"""

import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DOCS = os.path.dirname(ROOT)

SM1996 = os.path.join(DOCS, "Manuals", "5700A_5720A_Service_Manual_1996_Rev1_2002.pdf")
CH6 = os.path.join(
    DOCS, "Schematics_and_Parts_Lists", "5700A_Rev9_ServiceManual_Ch6_Replaceable_Parts_List.pdf"
)

# Per-assembly source locations. Page numbers are 1-based PDF pages.
CONFIG = {
    "a18": {
        "name": "Filter/PA Supply PCA",
        "pca": "761189",
        "rev": "H",
        "parts_table": "Table 6-23. A18 Filter/PA Supply PCA",
        "rev9_bom_pages": [78, 79, 80],
        "supply_tables": [
            "Table 2-8. Unregulated Supplies from the Filter Assembly",
            "Table 2-9. Regulated Supplies from the Filter/PA Supply",
        ],
        "procedure": "5-23. Troubleshooting the Filter/PA Supply Assembly (A18)",
    },
    "a12": {
        "name": "Oscillator Control PCA",
        "pca": "761130",
        # Read off the photographed board's silkscreen: 'OSCILLATOR CONTROL /
        # 761130 REV K', artwork 5700A-3050 REV P. The manuals do not print a
        # revision letter for this assembly anywhere.
        "rev": "K",
        "parts_table": "Table 6-15. A12 Oscillator Control PCA",
        "rev9_bom_pages": [51, 52, 53],
        # A12 generates no supply Chapter 2 tabulates. Every rail it uses comes
        # from A17 except +5 OSC, which U25 regulates locally from +15 OSC
        # (§2-119), and the manuals publish no nominal for any of them at an A12
        # test point. The expectations that do exist are the eight signal test
        # points of §5-17 and the 3400-series fault codes, both curated by hand
        # into data/a12.testpoints.json and data/a12.reference.json.
        "supply_tables": [],
        "procedure": "5-17. Troubleshooting the Oscillator Control Assembly (A12)",
    },
    "a14": {
        "name": "High Voltage Control PCA",
        "pca": "775429",
        "rev": None,
        "parts_table": "Table 6-18. A14 High Voltage Control PCA",
        "rev9_bom_pages": [61, 62],
        # A14 generates no supply of its own that Chapter 2 tabulates -- the
        # rails it makes (+/-HVDC, VI+/VI-, +/-SP C) are all measured in the
        # 5-19 procedure instead, at connector pins and component leads rather
        # than at test points. So the expectations are curated by hand into
        # data/a14.testpoints.json, mostly as probePoints.
        "supply_tables": [],
        # Printed as two sections, walked as one sequence -- see parse_procedures.
        "procedure": ["5-19. Troubleshooting the High Voltage Control Assembly (A14)",
                      "5-20. Magnitude Control Circuit"],
    },
    "a13": {
        "name": "Oscillator Output PCA",
        # Table 6-1 and the silkscreen on the photographed board both say
        # 761148; the Manual Status Information table says 1607704 rev 003.
        # See the caveat in a13.reference.json.
        "pca": "761148",
        "rev": "H",
        "parts_table": "Table 6-16. A13 Oscillator Output PCA",
        # Confirmed by reading: Table 6-16 runs 55-57 in the Rev 9 Ch6 scan.
        # The page map's estimate of ~57 is the table's *last* page.
        "rev9_bom_pages": [55, 56, 57],
        # A13 generates no supply Chapter 2 tabulates. It takes every rail from
        # A17 except -12 S, which U2 makes locally from -17 S (2-130), and its
        # ten test points are signal points rather than rails. Every expectation
        # is curated by hand into data/a13.testpoints.json from 5-18 and the
        # 3400-series fault codes.
        "supply_tables": [],
        "procedure": "5-18. Troubleshooting the Oscillator Output Assembly (A13)",
    },
    "a15": {
        "name": "High Voltage/High Current PCA",
        "pca": "761155",
        "rev": "G",
        "parts_table": "Table 6-19. A15 High Voltage/High Current PCA",
        "rev9_bom_pages": [64, 65, 66],
        # Like A14, A15 makes no supply that Chapter 2 tabulates. Its only local
        # rails are the +/-20 S pair that VR3 and VR4 shunt-regulate from +/-44 S,
        # and the only published expectation for those is 5-21 step 2. Everything
        # else is curated by hand into data/a15.testpoints.json.
        "supply_tables": [],
        "procedure": "5-21. Troubleshooting the High Voltage/High Current Assembly (A15)",
    },
    "a16": {
        "name": "Power Amplifier PCA",
        "pca": "761163",
        "rev": None,
        "parts_table": "Table 6-20. A16 Power Amplifier PCA",
        "rev9_bom_pages": [68, 69, 70, 71],
        # A16 generates no supply Chapter 2 tabulates. Table 2-13 lists which
        # +/-PA mode A18 is switched into for each output, not a measurable
        # nominal, so it is carried as a reference table in a16.reference.json
        # and every expectation is curated by hand from 5-22.
        "supply_tables": [],
        "procedure": "5-22. Troubleshooting the Power Amplifier Assembly (A16)",
    },
    "a11": {
        "name": "DAC PCA",
        "pca": "761122",
        # The board is silkscreened "DAC ASSY 761122 REV" with the letter left
        # blank and stamped per board; the photograph's reads P. The locator
        # drawing carries the same blank field, so unlike A18 the revision here
        # comes from the photo alone.
        "rev": "P",
        "parts_table": "Table 6-12. A11 DAC PCA",
        # The page-map's estimate of ~44 is the middle of this table, not its
        # start: Table 6-12 runs 42-45 and page 46 is the Chapter 6 duplicate of
        # the locator drawing. Confirmed by reading all four page headings.
        "rev9_bom_pages": [42, 43, 44, 45],
        # A11 generates no supply Chapter 2 tabulates -- it consumes the FR1,
        # FR2, S, LH and RLH rails made by A17 and A19 -- so every expectation
        # is curated by hand into data/a11.testpoints.json from §5-13 to §5-16
        # and from the sheet 1 test point legend.
        "supply_tables": [],
        # Printed as four sections and walked here as one sequence. See the
        # 'procedure' caveat in data/a11.reference.json for why, and note that
        # unlike A14 the manual gives no numeric cross-reference between them --
        # §5-13 hands off to §5-14 by name ("skip to Duty Cycle Control
        # Circuit"), so the renumbering is this dataset's, not the manual's.
        "procedure": ["5-13. Troubleshooting the DAC Assembly (A11)",
                      "5-14. Duty-cycle Control Circuit",
                      "5-15. ADC Circuit",
                      "5-16. Buffered Reference SIP Assembly (A11A2):"],
    },
    "a19": {
        "name": "Digital Power Supply PCA",
        "pca": "761056",
        # The drawing and the Chapter 6 duplicate both print "761056 REV" with
        # the letter left blank and stamped per board, as on A11. The letter
        # comes from the photographed board's silkscreen: REV F.
        "rev": "F",
        "parts_table": "Table 6-24. A19 Digital Power Supply PCA",
        # Confirmed by reading both page headings: Table 6-24 runs 82-83 in the
        # Rev 9 Ch6 scan, and page 84 is the Chapter 6 duplicate of the locator
        # (Figure 6-26). The page map's estimate of ~82 is the table's first page.
        "rev9_bom_pages": [82, 83],
        "supply_tables": [
            "Table 2-2. Supplies Generated by the Digital Power Supply",
        ],
        # Chapter 5's component-level sections stop at 5-23 (A18); A19 has none,
        # and unlike A17 it has no fault codes either -- A19 powers the CPU that
        # would have to report one, so a dead rail here presents as an instrument
        # that will not boot. Its published description is §2-24 to §2-29, which
        # is curated into data/a19.reference.json.
        "procedure": None,
    },
    "a16a1": {
        "name": "Power Amplifier Digital Control SIP PCA",
        "pca": "775320",
        # The drawing prints "DIGITAL CONTROLLER ASS 775320 REV" with the
        # letter blank; the Manual Status Information table gives rev C.
        "rev": "C",
        "parts_table": "Table 6-21. A16A1 Power Amplifier Digital Control SIP PCA",
        # Confirmed by reading: the whole of Table 6-21 is Rev 9 Ch6 page 73,
        # and page 72 is the Chapter 6 duplicate of A16's locator.
        "rev9_bom_pages": [73],
        "supply_tables": [],
        # No Chapter 5 section and no test points. Fault codes 3500-3503, 3521
        # and 3530 are titled A16 but exercise this board's 82C55 (U11); they
        # are curated into data/a16a1.reference.json.
        "procedure": None,
    },
    "a13a1": {
        "name": "Oscillator Wideband SMD PCA",
        "pca": "761403",
        # Manual Status Information table: 761403 rev C. The drawing carries no
        # revision field at all.
        "rev": "C",
        "parts_table": "Table 6-17. A13A1 Oscillator Wideband SMD PCA",
        # Confirmed by reading: Table 6-17 is the single Rev 9 Ch6 page 59;
        # page 58 is the Chapter 6 duplicate of A13's locator and 60 of this one.
        "rev9_bom_pages": [59],
        "supply_tables": [],
        # No Chapter 5 section of its own: A13's 5-18 step 8 is the only bench
        # check that names it, and no fault code does.
        "procedure": None,
    },
    "a21": {
        "name": "Rear Panel PCA",
        "pca": "761221",
        # Manual Status Information table: 761221 rev 101.
        "rev": "101",
        "parts_table": "Table 6-27. A21 Rear Panel PCA",
        # Confirmed by reading both headings: Table 6-27 runs 90-91 in the
        # Rev 9 Ch6 scan, and page 92 is the Chapter 6 duplicate of the locator.
        "rev9_bom_pages": [90, 91],
        # A21 generates nothing: +5 LOGIC and +/-12 V come from A19 (Table 2-2)
        # and the +/-5LH and +5RLH rails from A17 (Table 2-10). The fifteen test
        # points are curated by hand from the sheet 1 legend.
        "supply_tables": [],
        # Chapter 5 stops at 5-23 (A18); fault codes 3700-3705 and 3708 are the
        # published procedure and live in data/a21.reference.json.
        "procedure": None,
    },
    "a20": {
        "name": "CPU PCA",
        # The photographed board's silkscreen reads "MAIN CPU ASSY REV F
        # 761072" over etch "5700A-3006 REV G (c) 1987 FLUKE USA". 761072 is the
        # through-hole assembly this instrument carries. Table 6-1 of the 1996
        # manual lists three later part numbers under the same A20 designator --
        # 1591070 (5700A Series I), 1639013 (5700A Series II) and 1626228
        # (5720A) -- none of which is this board. See the 'variant' caveat in
        # data/a20.reference.json.
        "pca": "761072",
        # Hand-inked into a blank field, as on A11, A19 and A8.
        "rev": "F",
        # Two headings, because the manual mis-numbers the continuation page.
        # 6-25 is A20's table and 6-26 is its second page, headed "A20 CPU PCA
        # (cont)"; A21's table is 6-27. A19's and A21's own continuations reuse
        # their numbers, so 6-26 is a printing mistake rather than a second
        # table -- but parse_parts_1996 stops at any unrecognised "Table 6-"
        # heading, so naming only 6-25 silently loses U19, U25-U33, U52, XBT1,
        # Y1, Y3 and Z1-Z5.
        "parts_table": ["Table 6-25. A20 CPU PCA",
                        "Table 6-26. A20 CPU PCA (cont)"],
        # Confirmed by reading all four page headings: Table 6-25 runs 85-88 in
        # the Rev 9 Ch6 scan, and pages 87-88 are a *duplicate scan* of 85-86 --
        # same rows, same stock numbers, same order, differing only in OCR
        # noise. Page 84 and page 89 are both Chapter 6 duplicates of the
        # locator drawing, and page 90 is already Table 6-26 (A21) in Rev 9's
        # numbering. Only the first copy is read; feeding both would join every
        # row against itself. The page map's estimate of ~85 is right.
        "rev9_bom_pages": [85, 86],
        # A20 generates no supply Chapter 2 tabulates. It runs on the +5 V and
        # +/-12 V the Digital Power Supply (A19) delivers through P61/P62, and
        # its only local source is BT1, the 3 V lithium cell that backs up the
        # clock/calendar. Every expectation is curated by hand into
        # data/a20.testpoints.json from the sheet 1 test point legend and the
        # 2-30 to 2-45 circuit descriptions.
        "supply_tables": [],
        # Chapter 5's component-level sections stop at 5-23 (A18); A20 has none.
        # Nor does it have fault codes: 5-2 was read end to end and not one of
        # its 130 codes names A20 or the CPU, even as a fallback. That is not an
        # omission but the architecture -- A20 is the processor that runs the
        # diagnostics and reports every other assembly's code, so a fault here
        # presents as an instrument that will not boot rather than as a number
        # on the display. The nearest thing to a published A20 procedure is
        # 4-21, replacing the clock/calendar battery, which is curated into
        # data/a20.reference.json. See the 'faultCodes' caveat there.
        "procedure": None,
    },
    "a4": {
        "name": "Digital Motherboard PCA",
        # Table 6-1 and the Manual Status Information table both give 760942;
        # the photographed board's silkscreen reads 'A4 / DIGITAL MOTHERBOARD
        # ASSY / 760942 REV F / (c) 1988 FLUKE MADE IN USA'.
        "pca": "760942",
        # The stamped letter, as on A8, A11 and A19. The Manual Status
        # Information table separately documents this assembly at revision
        # *level* 101, which is a different numbering -- see the 'revision'
        # caveat in data/a4.reference.json.
        "rev": "F",
        "parts_table": "Table 6-5. A4 Digital Motherboard PCA",
        # A single page, confirmed by reading the headings either side: Rev 9 Ch6
        # page 19 is the tail of Table 6-4 (A3), page 20 is 'Table 6-5. A4
        # Digital Motherboard PCA' entire -- it ends with W90 and the two
        # footnotes -- and page 21 is the Chapter 6 duplicate of the locator
        # drawing (Figure 6-7), with Table 6-6 (A5) starting on page 22. The page
        # map's estimate of ~22 is two pages late and lands inside A5's table.
        "rev9_bom_pages": [20],
        # A4 generates nothing. It is the backplane: it carries the line-select
        # switches, the line fuse, the power switch, the two fibre-optic ends
        # (J73/J74) and the connectors for A22, A19, A20, A2, A21 and the two
        # 24 V fans (2-17). Every rail on it is made somewhere else and merely
        # passes through, so no Chapter 2 table tabulates a value at an A4 point
        # -- there is no A4 supply table and no A4 connector table either
        # (Table 2-1 is the *Analog* Motherboard's, for A3). The pin-level
        # information exists only on schematic sheets 1-3.
        "supply_tables": [],
        # Chapter 5's component-level sections run 5-4 (A5) to 5-23 (A18); A4 is
        # below the range and has no section. 5-2 states outright that every
        # fault code assumes "the Motherboard assemblies are fully operational",
        # so there is no A4 fault code either -- see the first caveat in
        # data/a4.reference.json. The published description is 2-16 to 2-18.
        "procedure": None,
    },
    "a17": {
        "name": "Regulator/Guard Crossing PCA",
        "pca": "761171",
        "rev": None,
        "parts_table": "Table 6-22. A17 Regulator/Guard Crossing PCA",
        "rev9_bom_pages": [75, 76],
        "supply_tables": [
            "Table 2-10. Regulated Outputs from the Regulator/Guard Crossing Assembly",
        ],
        # Chapter 5's component-level sections stop at 5-23 (A18); A17 has none.
        # Its published troubleshooting lives in the 3600-series fault codes of
        # 5-2, which are prose keyed by code rather than numbered steps, so they
        # are curated into data/a17.reference.json instead of parsed here.
        "procedure": None,
    },
    "a7": {
        "name": "Current/High-Resolution Oscillator PCA",
        # Table 6-1 and the Manual Status Information table both give 764613.
        "pca": "764613",
        # Not a stamped letter like A11's or A19's: the Manual Status Information
        # table prints this assembly's revision *level* as 203, and the
        # photographed board carries only the etch number, 5700A-3021 REV M, with
        # no assembly revision anywhere on the silkscreen. See the 'revision'
        # caveat in data/a7.reference.json.
        "rev": "203",
        "parts_table": "Table 6-8. A7 Current/High-Res Oscillator PCA",
        # Confirmed by reading all three page headings: Table 6-8 runs 30-32 in
        # the Rev 9 Ch6 scan, and page 33 is the Chapter 6 duplicate of the
        # locator (Figure 6-10). The page map's estimate of ~32 is the table's
        # last page, not its first.
        "rev9_bom_pages": [30, 31, 32],
        # A7 generates no supply Chapter 2 tabulates. Every rail it uses arrives
        # on P212 from A17 and A19 -- +/-17 S, +/-5 LH, +8 RLH, +5 RLH, +5 SRLH --
        # and the +/-17 LH pair is derived locally through L7/L8 from +/-17 S.
        # None of them has a published nominal at an A7 test point, so every
        # expectation is curated by hand into data/a7.testpoints.json from
        # 5-7, 5-8 and the 2700-series fault codes.
        "supply_tables": [],
        # Printed as a parent section with two numbered sub-sections. 5-6 itself
        # carries no numbered steps at all -- it is four lines of prose saying
        # the two circuits are independent and are troubleshot separately -- so
        # only the two sub-sections are parsed. They are walked here as one
        # 24-step sequence, which is the only shape the dataset has; see the
        # 'procedure' caveat in data/a7.reference.json for why that renumbering
        # is this dataset's and not the manual's, and what it does to 5-8 step
        # 4's printed "skip to step 9".
        "procedure": ["5-7.   Current Section",
                      "5-8.   Hi-Res Oscillator Section"],
    },
    "a8": {
        "name": "Switch Matrix PCA",
        "pca": "761106",
        # The locator prints "SWITCH MATRIX REV" with the letter left blank and
        # stamped per board, as on A11 and A19. The letter comes from the
        # photographed board's silkscreen: REV M, etch 5700A-3020 REV M. The
        # Manual Status Information table gives this assembly revision level
        # 105, which is a different numbering from the stamped letter.
        "rev": "M",
        "parts_table": "Table 6-9. A8 Switch Matrix PCA",
        # Confirmed by reading both page headings: Table 6-9 runs 34-35 in the
        # Rev 9 Ch6 scan, and page 36 is the Chapter 6 duplicate of the locator
        # (Figure 6-11). Page 33 is A7's locator, so 34 is the table's first page.
        "rev9_bom_pages": [34, 35],
        # A8 generates no supply Chapter 2 tabulates. Every rail it runs on --
        # +8 RLH, +5 RLH, RLH COM, +5 LH, LH COM, -5 LH, +17 S, S COM, -17 S --
        # arrives through P202 from A17, and the board's own diagnostic mux is
        # what measures them for the 3600-series fault codes. Its ten test points
        # are signal points rather than rails, so every expectation is curated by
        # hand into data/a8.testpoints.json from 5-9 and the sheet 1 legend.
        "supply_tables": [],
        # Three spaces after the section number, which is how the 1996 text
        # layer prints this one heading; a single space matches nothing and the
        # section comes back with no steps at all.
        "procedure": "5-9.   Troubleshooting the Switch Matrix Assembly (A8)",
    },
    "a9": {
        "name": "Ohms Cal PCA",
        # Table 6-1 lists the assembly as 'A9 * OHMS,CAL PCA 775395'.
        "pca": "775395",
        # The locator drawing and the photographed board both print
        # "OHMS CAL ASSY / 775395 REV" with the letter left blank and stamped
        # per board, as on A11, A19 and A8 -- and on this board the field was
        # never stamped, so there is no revision letter to record.
        "rev": None,
        "parts_table": "Table 6-10. A9 Ohms Cal PCA",
        # Confirmed by reading all four page headings: Table 6-10 starts on 37
        # ("Table 6-10. A9 Ohms Cal PCA"), continues on 38 ("(cont)"), and page
        # 39 is the Chapter 6 duplicate of the locator (Figure 6-12); page 40 is
        # already Table 6-11 (A10). The prep survey's estimate of 38-39 is one
        # page late -- 38 is the table's *second* page, not its first.
        "rev9_bom_pages": [37, 38],
        # A9 generates no supply Chapter 2 tabulates. It runs on the rails A17
        # and A19 deliver through P312 (+/-17 S, S COM, +5 RLH, RLH COM, +5 LH,
        # LH COM, -5 LH) and makes one pair of its own, the +/-8A floating
        # supply of the two-wire compensation circuit, whose only published
        # expectation is 5-11 step 1. Every expectation is curated by hand into
        # data/a9.testpoints.json from 5-10, 5-11, the 3300-series fault codes
        # and the sheet 1 test point legend.
        "supply_tables": [],
        # Printed as two sections and walked here as one sequence, as on A11.
        # Unlike A14 the manual gives no numeric cross-reference that requires
        # it -- 5-11 step 1's "skip to step 2" resolves inside 5-11 -- so the
        # renumbering is this dataset's, not the manual's. See the 'procedure'
        # caveat in data/a9.reference.json.
        "procedure": ["5-10. Troubleshooting the Ohms Cal Assembly (A9)",
                      "5-11. Two-wire Compensation Circuit"],
    },
    "a5": {
        "name": "Wideband Output PCA",
        # Table 6-1 (Manual Status Information) and the board's own silkscreen
        # both give 761346.
        "pca": "761346",
        # Numeric, and not read off the silkscreen: the drawing and the board
        # both print "761346 REV" with the field left blank and stamped per
        # board, and on the photographed board it was never stamped -- someone
        # has hand-marked "REV 104" beside it in marker instead. The Manual
        # Status Information table documents revision level 105, so the board in
        # the photograph is one level behind the manual. The etch legend under
        # the silkscreen reads 5700A-3011 REV F, which is the artwork revision
        # and a different numbering again. See the 'revision' caveat in
        # data/a5.reference.json.
        "rev": "104",
        "parts_table": "Table 6-6. A5 Wideband Output PCA",
        # Confirmed by reading all three page headings: Table 6-6 runs 22-24 in
        # the Rev 9 Ch6 scan ("(cont)" on 23 and 24), page 25 is the Chapter 6
        # duplicate of the locator (Figure 6-8) and page 26 is already Table 6-7
        # (A6). The page map's estimate of ~24 is the table's *last* page, not
        # its first -- the A15 failure mode, and starting there would have lost
        # two thirds of the manufacturer columns without a warning.
        "rev9_bom_pages": [22, 23, 24],
        # A5 generates no supply Chapter 2 tabulates. Every rail arrives on P111
        # from A17 and A19 -- +/-17 S, S COM, +5 LH, LH COM, -5 LH, +5 RLH,
        # RLH COM -- and the board's only local work on them is the six 6-turn
        # chokes L1-L6, which turn each one into its own "S"-suffixed net
        # (+17 S -> +17S, +5 RLH -> +SRLH, and so on). None of them has a
        # published nominal at an A5 test point, so every expectation is curated
        # by hand into data/a5.testpoints.json from 5-4, the 3900-series fault
        # codes and the sheet 1 test point legend.
        "supply_tables": [],
        # Three spaces after the section number, as on A8: the 1996 text layer
        # prints this heading that way and a single space matches nothing, which
        # brings the section back with no steps at all.
        "procedure": "5-4.   Troubleshooting the Wideband Output Assembly (A5)",
    },
    "a10": {
        "name": "Ohms Main PCA",
        # Table 6-1 lists the assembly as 'A10 * OHMS,MAIN PCA 761114', and the
        # Manual Status Information table gives the same number.
        "pca": "761114",
        # Numeric, not a letter. The photographed board's silkscreen reads
        # "OHMS MAIN ASSY REV" with the field hand-inked 101, over etch
        # "5700A-3030 REV 101 (c) 1987 FLUKE". The Manual Status Information
        # table documents revision level 100 for this assembly, so the board in
        # the photograph is one level newer than the manual -- see the 'revision'
        # caveat in data/a10.reference.json.
        "rev": "101",
        "parts_table": "Table 6-11. A10 Ohms Main PCA",
        # A single page, confirmed by reading the headings either side: Rev 9 Ch6
        # page 39 is the Chapter 6 duplicate of A9's locator (Figure 6-12), 40 is
        # "Table 6-11. A10 Ohms Main PCA" entire, 41 is this board's own locator
        # duplicate (Figure 6-11) and 42 is already Table 6-12 (A11). The prep
        # survey's 41-43 was a Figure/Table confusion: page 41 does print
        # "6-11. A10 Ohms Main PCA", but as a *Figure* caption.
        "rev9_bom_pages": [40],
        # A10 generates no supply at all -- it has no regulator, and the only
        # active devices are U1 and the relay drivers. It takes +/-17 S, S COM,
        # +5 LH / LH COM and +5 RLH / RLH COM from the motherboard through P302
        # and does nothing to them. Chapter 2 tabulates none of that, and 5-12
        # measures no voltage anywhere: every step is a four- or two-wire
        # resistance reading taken across TP2-TP5. So the test point entries in
        # data/a10.testpoints.json carry resistance expectations rather than
        # voltages, curated by hand from 5-12, Table 5-2 and the sheet 1 legend.
        "supply_tables": [],
        # One section, four steps, no sub-sections -- unlike A7, A9 and A11 there
        # is no judgement call to make here.
        "procedure": "5-12. Troubleshooting the Ohms Main Assembly (A10)",
    },
    "a6": {
        "name": "Wideband Oscillator PCA",
        # Table 6-1, the Manual Status Information table and the locator's own
        # silkscreen all give 761098.
        "pca": "761098",
        # The locator prints "WIDEBAND OSC ASSEMBLY 761098 REV" with the letter
        # left blank and stamped per board, as on A8, A9, A11 and A19. On the
        # photographed board it is inked H, over etch 5700A-3010 REV C. The
        # Manual Status Information table gives this assembly revision level
        # 104, which is a different numbering from the stamped letter.
        "rev": "H",
        # The 1996 text layer prints the table's caption with the assembly name
        # misspelled -- "Ocillator", one s -- on all three of its pages, while
        # the Rev 9 scan and the Chapter 7 caption both spell it correctly. The
        # title has to match what is printed or the table is not found at all.
        "parts_table": "Table 6-7. A6 Wideband Ocillator PCA",
        # Confirmed by reading all three page headings: Table 6-7 runs 26-28 in
        # the Rev 9 Ch6 scan, page 25 is the Chapter 6 duplicate of A5's locator
        # and page 29 is this board's own (Figure 6-7). The page map's estimate
        # of ~28 is the table's last page, not its first.
        "rev9_bom_pages": [26, 27, 28],
        # A6 generates no supply Chapter 2 tabulates. Per 2-217 it takes +5 LH,
        # -5 LH, +17 S and -17 S from the Regulator/Guard Crossing assembly
        # (A17) through P101 and makes five local rails from them: -5F (L12 and
        # C49 buffering -5 LH), +2.5 (R66/R67 dividing +5 LH), +12 (VR1 and R39
        # from +17 S) and -12/-11/-9.5 (VR4, VR5, R40, R41, CR8 and CR9 from
        # -17 S). None of them has a published nominal at an A6 test point, so
        # every expectation is curated by hand into data/a6.testpoints.json from
        # 5-5, the sheet 1 test point legend and the 3900-series fault codes.
        "supply_tables": [],
        # Three spaces after the section number, as on A8 -- a single space
        # matches nothing and the section comes back with no steps at all.
        "procedure": "5-5.   Troubleshooting the Wideband Oscillator Assembly (A6)",
        # §5-5 closes with Table 5-1 and then Figure 5-5's caption, both after
        # its last step, so step 14 -- "connect an oscilloscope to TP14 and
        # verify a distortion-free sine wave" -- collected a five-row table of
        # multiplexer logic levels and a reference to U9 that belongs to step
        # 11. The table is carried in data/a6.reference.json as muxSelect,
        # where step 10 cites it and it can be read as a table.
        "procedure_stops_at": "Table 5-1.",
    },
}

# OCR mangles the designator column of the scanned Rev 9 list (the text is
# small and the column is narrow). These are the observed corruptions; the
# right-hand side is confirmed against the 1996 text layer and the drawing.
# Only used for the designator fallback join -- the primary join is on stock no.
# Keys are the designator field after normalisation (uppercased, whitespace
# removed). Values are the correct designators, confirmed against the 1996 text
# layer and the board drawing.
# Keyed by assembly, because the same garbled string can mean different things
# on two boards -- 'C221' is A18's C21, and nothing stops a future assembly from
# having a real C221. Scoping them keeps one board's corrections from silently
# rewriting another's parts list.
OCR_DESIGNATOR_FIXES = {
    "a16a1": {
        # 'vu iil' -- the column rule reads as a v and the two 1s as an i and
        # two ls. The row is U11, the 82C55; stock 780650 joins it regardless.
        "VU": "U11",
    },
    "a13a1": {
        "E2": "C2",                  # 'e2'
        "A": "C11",                  # '@ a' -- the C reads as @ and is stripped
        "A1": "Q1",                  # 'ail' -- arrives as A1 after the i->1 pass
        "A9": "Q9",                  # 'a9'
        # 'R7, 16, 18, / R19, 21, 27- 4, / R 29' -- the 4 after the dash is
        # the ESD asterisk, and the range is R27-R29 (Tot Qty 8 = R7, R16,
        # R18, R19, R21, R27, R28, R29).
        "R19,21,27-4": "R19,21,27-",
    },
    "a21": {
        "EC1I1-15": "C11-15",        # 'ec 1i1- 15'
        "G1": "J1",                  # 'g1'
        "A4": "J4",                  # 'a4'
        "A5,6": "J5,6",              # 'a5, 6'
        "UO7": "J7",                 # 'uo 7'
        "A9": "J9",                  # 'a9'
        "J,I1,12": "J11,12",         # 'J i1, 12'
        "U1I1,12": "U11,12",         # 'U1i1, 12'
        "VU13": "U13",               # 'vu 13'
    },
    "a5": {
        # This board's capacitor prefix reads as 'G' on the two rows whose first
        # designator sits hard against the column rule, the same artefact A11
        # and A9 produce. Neither row joins any other way: both continuation
        # lines are bare 'C nn' and would attach to whatever row was still open.
        "GC6,52,S53": "C6,C52,C53,",     # 'GC 6, 52, S53,' -- 'S53' is C53
        "GC8,9,25": "C8,C9,C25,",        # 'GC 8, 9, 25,'
        # 'CRi1- 4, 6, 4' -- CR1's second character is read as an i, which makes
        # the whole range unparseable and takes the bare '6' down with it: with
        # no prefix in scope CR6 cannot be resolved either.
        "CRI1-4,6": "CR1-4,CR6,",
        "MS": "M5",                      # 'MS  SHIELD,WB OUTPUT,ATTENUATOR,FRONT'
        # 'QO 7s 8 4' -- Q7's zero-for-comma and the 's' for the comma after it,
        # and then Q8's digit sits in the ESD-marker column and is trimmed as
        # one. Without this Q8 has no manufacturer columns and no as-built row.
        "QO7S": "Q7,Q8",
        "Q1L-13": "Q11-13",              # 'Q1l- 13' -- Q11's second 1 as an l
        "OO17": "Q17",                   # 'oO 17' -- the whole prefix is noise
        # 'R, 30,103,105,' -- a comma between the prefix and its first number
        # leaves 'R' as a token of its own, and the three numbers after it then
        # have no prefix in scope at all.
        "R,30,103,105": "R30,R103,R105,",
        "RS8,59": "R58,R59",             # 'RS8, 59'
        "US": "U5",                      # 'US 4  IC,OP AMP,LO-OFFSET VOLTAGE'
    },
    "a12": {
        "C1I-4,12": "C1-4,C12",      # 'c1i- 4, 12,' -- the 1 of C1 is doubled
        # The Rev 9 row for stock 747519 runs over seven printed lines and the
        # scan merges two of them into unreadable noise ('\G 49, so, se, rdcr se').
        # The page itself prints 'C 23, 24, 36- / C 38, 44- 47, / C 49, 50, 56,'
        # -- read off .build/a12/ocr/p51.png and identical to the 1996 row -- so
        # the lost designators are restored here rather than left as an error.
        "23,24,36-": "C23,C24,C36-38,C44-47,C49,C50,C56,",
        "EC,SS": "C55",              # 'ec ss'
        "CR1I-3": "CR1-3",           # 'CR 1i- 3'
        "L1I-": "L1-4",              # 'L1i- 4' -- the 4 is eaten by the desc column
        "QS,9,11": "Q5,9,11",        # 'Qs, 9, 11'
        "RS,13,25": "R5,13,25",      # 'RS, 13, 25,'
        "U5S,26": "U5,26",           # 'u 5S, 26'
        "VU10": "U10",               # 'vu 10' -- the leading V is the ESD asterisk
        "ZS": "Z5",                  # 'zs'
    },
    "a18": {
        "CC,I121": "C11",     # 'Cc i121'
        "C221": "C21",        # '© 221'
        "CR,IS": "CR13",      # 'CR is'  (continuation of the UES1303 group)
        "CR12,15,17": "CR11,15,17",  # CR12 is in the UES1303 group; this row is CR11
        "F1I,S2,8": "F1,2,8",        # 'Fi1i,s 2, 8'
    },
    "a14": {
        "CIS": "C15",                # 'cis'
        "CCR1-4": "CR1-4",           # 'CcR1-4'
        "R3S-39,50": "R35-39,R50",   # 'R 3S=- 39; 50,'  (continues 'R 52')
        "VU4": "U4",                 # 'vu 4' -- the leading V is the ESD asterisk
        # A smudge before the 6 reads as a 5. Confirmed against the page: the
        # row is R6,R8 at 23.2 ohms, qty 2, and R5 is a 200K bleeder two rows up.
        "R5,8": "R6,8",
    },
    "a15": {
        "CA": "C4",                  # 'ca  CAP,POLYPR,0.022UF' -- the 4 read as an a
        "EC10": "C10",               # 'ec 10'
        # 'MP 4  MOLDED COVER,REFERENCE HYBRID'. MP4's own number sits exactly
        # where the ESD marker column does, and the marker is scanned as a '4',
        # so the designator's digit is eaten as a marker and 'MP' is left.
        "MP": "MP4",
        "MP,S": "MP5",               # 'MP S'
        "WWW2,3": "W2,W3",           # 'wWw2, 3'
    },
    "a16": {
        "E141": "C11",               # 'e141'
        "E415": "C15",               # 'e415'
        "QS": "Q5",                  # 'Qs'
        "Q4I,3": "Q1,3",             # 'Qi4i, 3' -- the 4 is the ESD asterisk
        "Q1": "Q11",                 # 'Qil' -- Q11, not Q1; Q1 is on the row above
        "Q1S,17": "Q15,17",          # 'Q1s, 17'
        "R1II,12": "R11,12",         # 'R1ii, 12'
        "VU2,5": "U2,5",             # 'vu 2, 5'
        "UT": "U7",                  # 'UT 4'
        "MP": "MP4",                 # 'MP 4 MOLDED COVER' -- the 4 is the number, not the marker
        # 'H3, 4 SCREW...' -- here the 4 after the comma is H4, not the ESD
        # marker, and the row's quantity of 2 says so.
        "H3": "H3,4",
        # The ESD marker reads as a '4' and, on a continuation line, is followed
        # by the repeated stock number rather than by a description -- so the
        # marker rule leaves it, the comma before it makes it look like another
        # entry in the list, and it inherits the row's prefix. 'VR 22, 26, 28, 4'
        # becomes VR4, which is not on this board at all.
        "VR22,26,28,4": "VR22,26,28",
        "CR1-5,7,4": "CR1-5,CR7",
        "CR10,12-14,4": "CR10,CR12-14",
        "CR16,20,21,4": "CR16,CR20,CR21",
        "CR23-25,27,4": "CR23-25,CR27",
        # 'CR 29- 31, 61-' continues onto the next printed line as 'CR 67'.
        "CR29-31,61-4": "CR29-31,CR61-",
    },
    "a11": {
        # The scan renders this board's capacitor prefix as 'G' three times.
        # It cannot be fixed in REV9_CHAR_FIXES, which is applied to the whole
        # left-hand field including the start of the description, where a real
        # G is common ('GATE', 'REG', 'HI-VOLTAG').
        "G3": "C3",
        "G59,67": "C59,C67",
        "G110,111": "C110,C111",
        # 'MP 4  BAG,STATIC SHIELDING' -- MP4's own digit sits in the ESD marker
        # column and is eaten as one, exactly as on A15 and A16.
        "MP": "MP4",
        "VU19": "U19",               # 'vu 19' -- the leading V is the ESD asterisk
        # 'R39, 44, 83, 4' continues the 4.7K row; the trailing 4 is the ESD
        # marker, but a comma before it makes it look like another designator
        # and it inherits the R prefix. There is no R4 on this board.
        "R39,44,83,4": "R39,44,83",
        "R31,41,48,4": "R31,41,48",   # same, on the 10K row's continuation
        "Q20,21,52,4": "Q20,21,52",   # same, on the N-channel switch row
    },
    "a19": {
        # Two of these matter and the rest are tidiness. The Rev 9 rows for M1/M2
        # and VR5 carry stock numbers the 1996 list does not, so they can only be
        # attached by designator -- and without the fix both parts lose their
        # manufacturer columns and their as-built row entirely. The others all
        # join on stock number regardless; they are corrected so that review.txt
        # stays empty of noise and a new disagreement stands out in it.
        "MIS2": "M1,M2",             # 'Mis 2'  -- 'M 1,' with the 1 read as 'is'
        "VR,S": "VR5",               # 'VR S 4' -- the 5 read as an S, then the
                                     #             ESD marker read as a 4
        "EDA": "C1",                 # 'eda'  (C 1)
        "EIS": "C15",                # 'eis'  (C 15)
        "CC,I7": "C17",              # 'Cc i7'
        "5": "C5,C11",               # ': @ 5, iL'  -- the C and the 11 both lost
        "FS": "F5",                  # 'FS'
        "LI-6": "L1-6",              # 'Li- 6'
        "QS5": "Q5",                 # 'Qs5 4'
    },
    "a20": {
        # None of these is tidiness. A20's two parts lists describe two
        # different builds of the board -- the 1996 list is the surface-mount
        # Series II assembly, the Rev 9 list the through-hole one the drawing,
        # the photograph and this instrument actually carry -- so almost nothing
        # joins on stock number and every Rev 9 row is the only statement of
        # what is really fitted. A garbled designator here does not cost a
        # manufacturer column, it costs the part.
        #
        # Three of them would otherwise be missing outright, because the 1996
        # list has no such designator to fall back on:
        "VUI1S": "U15",              # 'vui1s'  -- U 15, the boot EPROM
        "VU18": "U18",               # 'vu 18'  -- U 18, the fourth EPROM
        "ZAA4": "Z4",                # 'ZaA4'   -- Z 4, the 10K SIP network
        # ...and the rest carry the as-built identity of a part the 1996 list
        # knows only in its surface-mount form:
        "CS": "C5",                  # 'cs'     -- C 5
        "LY2": "U2",                 # 'ly 2'   -- U 2, with the ESD marker
        "US5": "U5",                 # 'US5'    -- U 5
        "US": "U9",                  # 'US'     -- U 9
        "V2": "Y1",                  # 'v2.'    -- Y 1, the 7.3728 MHz crystal
        "3": "Y3",                   # '3'      -- Y 3, the 32.768 kHz crystal
        "21": "Z1",                  # '21'     -- Z 1
        # The scan drops the second designator of this row outright; the page
        # prints 'M 3, 4' and the row's own Tot Qty is 2.
        "M3": "M3,M4",               # 'M3'     -- M 3, 4, the two rubber feet
    },
    "a4": {
        # Two of these change the data and the rest are tidiness. 'swil' is SW1,
        # whose Rev 9 stock number (886697) differs from the 1996 one (665513),
        # so it can only be attached by designator -- without the fix the power
        # switch loses its manufacturer columns and its as-built row entirely.
        # The two footnote entries stop Chapter 6's own footnote being read as a
        # parts row (see below). The others all join on stock number regardless;
        # they are corrected so review.txt stays free of scan noise and the four
        # genuine Rev 9 disagreements on this board (J11, J41, SW1 and the
        # MP22/MP23 foot) stand out in it.
        "SWIL": "SW1",               # 'swil'  -- SW1 with the 1 read as 'il'
        "CS": "C5",                  # 'cs'
        "FOIL": "F1",                # 'Foil'  -- F1 with the 1 read as 'il'
        "JO14": "J14",               # 'Jo 14'
        "OG15": "J15",               # 'og 15'
        "JO16": "J16",               # 'Jo 16'
        "JO74": "J74",               # 'Jo 74'
        "SW2-": "SW2-4",             # 'SW 2- 4' -- the 4 eaten as an ESD marker
        "WIS": "W15",                # 'wis'
        # Not designators at all: Chapter 6's footnote 1 for this table, "1. Fuse
        # PN 109280 is for 100-120 volt configuration. For 200-230 volt
        # configuration / order PN 109231". Both printed lines carry a six-digit
        # number, so the row parser anchors on it and reads the sentence as a
        # row -- and because its stock number is F1's, the merge then overwrote
        # F1's manufacturer part with the sentence itself. Mapping the two
        # designator fields to nothing leaves the row with no refs, which is
        # what it is; REV9_MFR_FIXES_BY_STOCK below is what protects F1's
        # columns from the second line.
        "1": "",
        "ORDER,PN": "",
    },
    "a17": {
        "LC5,24,29": "C5,24,29",     # 'lc 5, 24, 29,'
        "C54,6,59": "C54,56,59",     # 'C 54, $6, 59,' -- '$6' is C56, not C6
        "EC112-114": "C112-114",     # 'ec 112-114'
        "FO1": "F1",                 # 'Fo1'
        "RIS,17": "R15,17",          # 'Ris, 17'
        "R,S57": "R57",              # 'R S57'
        "TP,S55,58": "TP55,58",      # 'TP S55, 58'
        "UT": "U7",                  # 'UT 4'  (the 4 is the ESD asterisk)
        "U,SI": "U51",               # 'U SI 4'
        "U64,4,32K": "U64",          # 'U 64 4 32K X 8 PROM' -- description bled left
    },
    "a8": {
        # 'C 2, 5' scanned as 'Cc2, 8'. The 5 read as an 8 puts C8 -- a 0.22 uF
        # polyester three rows down -- on the 33 pF row, and the doubled C makes
        # the whole field look plausible. Confirmed against the page at 400 dpi
        # and against the 1996 row, both of which read 'C 2, 5' for a Tot Qty
        # of 2.
        "CC2,8": "C2,C5",
        "CA4": "C4",                 # 'ca4'
        "20": "C20",                 # '€ 20' -- the C read as a euro sign
        "L1-": "L1-4",               # 'Li1- 4' -- the 4 is eaten as an ESD marker
        "Q6,7,121": "Q6,Q7,Q11",     # 'Q 6, 7, 11' with the 11 run into the marker
        "R1S-17,21": "R15-17,R21",   # 'R1S- 17, 21'
        "UT": "U1",                  # 'Ut 4' -- U1, not U7; this board has no U7
        "V4": "U4",                  # 'v4 4'
        # 'HY 1  HYBRID ASSEMBLY, TESTED' is deliberately left unfixed. It is
        # not an OCR error: the Rev 9 page really does print HY1 where the 1996
        # list prints H2, the board silkscreen prints HR1 and the schematic
        # prints all three. The row joins on stock 813436 regardless, so H2
        # keeps its manufacturer columns; rewriting the designator here would
        # bury a genuine four-way naming conflict in a table of scan artefacts.
        # See the 'hybrid names' caveat in data/a8.reference.json.
    },
    "a9": {
        "EC36": "C36",               # 'ec 36'
        # 'H1- 4  RIVET,...' -- the space before the 4 drops it into the
        # description column, leaving an open-ended range that parses to nothing.
        # The row's Tot Qty of 4 and the 1996 list both say H1-H4.
        "H1-": "H1-4",
        # 'M 4  SHIELD,OHMS CAL' and 'MP 4  SHIELD,HIGH VOLTAGE CONTROL'. Both
        # designators' own digit sits exactly where the ESD marker column does
        # and is eaten as one, the same artefact as A11/A15/A16's MP4.
        "M": "M4",
        "MP": "MP4",
        "WU21": "U21",               # 'WU 21' -- the leading W is the ESD asterisk
        "ZA4": "Z4",                 # 'ZA4'
    },
    "a6": {
        # 'c1- 8, 49-' / 'ec 51'. The row is the eleven 4.7 uF tantalums, and
        # the second printed line opens with the C read as 'ec'. Without this
        # the field ends '49-EC51', which parses to nothing and leaves C49, C50
        # and C51 -- three of the four rails' bulk decoupling -- out of the
        # Rev 9 row entirely.
        "C1-8,49-": "C1-8,C49-",
        "EC51": "C51",
        # The ESD marker column reads as a '4' (and once as a '7') on every
        # continuation line of the transistor and diode group rows. On a
        # continuation line it is followed by the repeated stock number rather
        # than by a description, so clean_rev9_left's marker rule leaves it, the
        # comma before it makes it look like another entry in the list, and it
        # inherits the row's prefix. That invented a CR4 on the PIN-diode row
        # (CR4 is a 1N4448 two rows up), a Q4 on both FET rows and a Q7 on the
        # SD210 row -- Q4 and Q7 are BFR96 hi-freq parts, so each one claimed
        # the wrong device had been fitted.
        "CR201,301,401,4": "CR201,CR301,CR401",
        "CR203,302,303,4": "CR203,CR302,CR303",
        "CR402,403,502,4": "CR402,CR403,CR502",
        "Q105,201,205,4": "Q105,Q201,Q205",
        "Q301,305,401,7": "Q301,Q305,Q401",
        "Q204,303,304,4": "Q204,Q303,Q304",
        "Q403,404,503,4": "Q403,Q404,Q503",
        # 'g1  CONN,COAX,SMB(M)' and 'a6  HEADER,1 ROW' -- J1 and J6. The J
        # reads as a g and as an a, and 'A6' is worse than unparseable: A is a
        # real designator family (A11's SIP daughter boards), so it created a
        # part called A6 -- the assembly's own name -- on the assembly's own
        # BOM, while J6 lost its manufacturer columns. J6 is the header §5-5
        # steps 6 to 9 tell you to unplug, so it is one of the parts the
        # procedure actually touches.
        "G1": "J1",
        "A6": "J6",
        # 'MP 10  75 OHM RF CABLE'. The description opens with a number, so the
        # designator/description split falls past it and the field becomes
        # 'MP 10 75', which expands to MP10 and a phantom MP75.
        "MP10,75": "MP10",
        # 'R 44  RES,CF,4.7K,+-5%,0.25W'. R44's own number sits exactly where
        # the ESD marker column does and is read as one, leaving a bare prefix
        # -- the same artefact as A11's and A15's MP4 and A7's C44, one column
        # further along.
        "R": "R44",
        "VU15": "U15",               # 'vu 15' -- the leading V is the ESD asterisk
    },
    "a7": {
        # None of these changes the data -- every one of their rows joins on
        # stock number regardless -- but they keep review.txt empty of scan
        # noise so that the four genuine Rev 9 disagreements on this board
        # (Q1, R14, R56/R57, VR3, Z3 and the XU sockets) stand out in it.
        "C50,5S": "C50,C51,C55",     # 'C 50, Si, 5S,' -- 51 as 'Si', 55 as '5S'
        "EG": "C9",                  # ', eg'
        "EC1I": "C11",               # 'ec1i'
        # 'Cc 44  CAP,CER,15PF' -- C44's own digits sit exactly where the ESD
        # marker column does, and the marker rule reads a two-digit run there,
        # so the number is eaten and a bare prefix is left. Same shape as A11's
        # and A15's MP4, one column further along.
        "CC": "C44",
        "HI-": "H1-4",               # 'Hi- 4' -- the 4 eaten as an ESD marker
        "K4,5S,8": "K4,K5,K8",       # 'K 4, 5S, 8,'
        "LI-3,5": "L1-3,L5",         # 'Li- 3, 5,'  (continues 'L7- 9')
        "L": "L4",                   # 'L 4  INDUCTOR,3.3UH' -- the 4 eaten again
        "Q1S5": "Q15",               # 'Q1s5 4'
        "U5S,18": "U5,U18",          # 'u 5s, 18'
        "VU,IL": "U11",              # 'vu il' -- leading V is the ESD asterisk,
                                     #            then 11 read as 'il'
        "VU15": "U15",               # 'vu 15'
        "VU19": "U19",               # 'vu 19'
        # 'XU 2, 3' is deliberately NOT corrected. The 1996 list prints XU1,XU2
        # and Rev 9 prints XU2,XU3 for the same stock number and the same Tot
        # Qty of 2, so the two revisions genuinely disagree about which pair of
        # 8-pin ICs is socketed. XU3 is dropped by rev9_only_is_plausible and
        # the drop is reported, which is the finding; see the 'sockets' caveat
        # in data/a7.reference.json.
    },
}

# Where the designator column is unreadable but the stock number survives, the
# stock number is the better key: it is a single isolated six-digit field. This
# is the only handle for a row whose garbled designator collides with a real one
# -- A17's Y51 reads as 'Y 52', which no designator-keyed fix can tell apart
# from the genuine Y52 row two lines below it.
REV9_ROW_FIXES_BY_STOCK = {
    "a5": {
        # '@ L  CAP,CER,4.7PF' -- the very first row of the table. The C is
        # scanned as an '@', which clean_rev9_left strips as leading punctuation,
        # and the 1 as an 'L', so the designator field arrives as a bare 'L'.
        # That is a real prefix on this board (L1-L6, L18-L23), so no
        # designator-keyed fix can tell it from a genuinely truncated inductor
        # row -- and left alone C1 loses its manufacturer columns entirely.
        "721837": "C1",
        # 'R99, 24, 27,' -- R9's digit is doubled. R99 is a real and different
        # part here (187 ohm, 0.1%, stock 807750, one of the four resistors that
        # set the 50 ohm output impedance), so leaving it gives R99 a 20k
        # carbon-film as-built row it never had, on the one part of this board
        # where the value is the specification.
        "697110": "R9,R24,R27,R42,R102",
        # 'Ril  RES,MF,20.5K' -- R11's second 1 reads as an l, which the row
        # parser drops, so the row arrives as a bare 'R1'. R1 is a real and
        # different part here (866 ohm, stock 320390, and Rev 9 lists it
        # correctly two rows up as 'Ri i'), exactly the A12/A9/A8/A7 case.
        "655233": "R11",
    },
    "a11": {
        # The 52-designator ceramic row runs over eleven printed lines and the
        # scan loses the '8' that closes its first range, so 'C 1, 2, 4-' joins
        # to 'C 8, 10, 11,' as C4-C10 and swallows C9. C9 is a 10 uF aluminium
        # can on both lists and on sheet 1, so the merge invented a revision
        # difference that would have had someone fit a 0.22 uF chip in its
        # place. Read off the page at 300 dpi; the field is identical to the
        # 1996 row, all 52 of them.
        "740597": "C1,C2,C4-8,C10,C11,C13-18,C21,C23-26,C41,C42,C46-49,C53-56,"
                  "C58,C62,C64,C65,C76,C77,C81,C86-88,C91,C92,C96-98,C100,C104-109",
        # Two consecutive rows both read as 'U 12'. The first is the TL071 the
        # 1996 list gives as U11, stock 783720, and the second is the genuine
        # U12/U37 opto row -- so without this the opto's designator is taken
        # from the op amp above it.
        "783720": "U11",
    },
    "a12": {
        # 'Ril' -- R11's second 1 is read as an l, which the row parser drops, so
        # the row arrives as a bare 'R1'. R1 is a real and different part on this
        # board (30k, stock 574251), so no designator-keyed fix can separate them.
        "697110": "R11",
        # 'R 44' -- the 44 falls into the description column and only the R is
        # left in the designator field, which expands to nothing at all.
        "573246": "R44",
        # 'R59, 50' -- R60's 6 is read as a 5. R50 is real and different (120
        # ohm, and Rev 9 lists it correctly two rows up as 'R 32, 50'), so
        # leaving this uncorrected gives R50 a 4.99k as-built row it never had.
        "721548": "R59,R60",
    },
    "a14": {
        # 'z1  CONN,MATE-N-LOK,HEADER,14 PIN' -- the J1 row. It normalises to
        # 'Z1', which is a real and different part on this board (the 10K SIP,
        # stock 412924), so no designator-keyed fix can tell the two apart.
        "845318": "J1",
    },
    "a15": {
        # The R23,R24,R60,R65 row's stock number is scanned as '"1572941' -- a
        # ditto mark read as a leading 1 -- and its 'R 65' continuation line
        # can be appended to whichever row is still open, which is R22.
        # Pinning the R22 row to R22 keeps R65 from being given a 16k
        # description it does not have. The stock number itself is corrected
        # in REV9_STOCK_FIXES, so those four now carry their as-built row.
        "641118": "R22",
    },
    "a17": {
        "800357": "Y51",   # '¥Y 52.  CRYSTAL,4.9152 MHZ' -- the 4.9152 part is Y51
    },
    "a8": {
        # 'Ril, 20, 35' -- R11's second 1 is read as an l and the row arrives as
        # a bare 'R1', exactly as on A12. R1 is a real and different part here
        # (15.4k, stock 772038), so a designator-keyed fix cannot tell the two
        # apart, and left alone R1 gains a 560 ohm as-built row it never had.
        "810440": "R11,R20,R35",
        # 'R 24   1/4 WATT HERM. W.W. RESISTOR'. The description opens with
        # '1/4', which carries no run of three letters, so the designator/
        # description split falls past it and the field becomes 'R 24 1/4' --
        # which expands to R24, R1 and R4. Both of those are real and different
        # parts, so this has to be keyed by stock number.
        "864207": "R24",
    },
    "a9": {
        # The 15-designator polyester row runs over four printed lines and the
        # scan mangles three of them: 'C 4, Ss 8,' loses C5 into an 'Ss', 'GC 10,
        # 14, 15,' and 'G31,' gain a leading G (this board's C reads as G on the
        # same rows A11's did), and '387= 43,' is '37- 43' with the hyphen read
        # as an 8 and an equals sign. Restored from the page at 300 dpi; the
        # field is identical to the 1996 row, all 15 of them.
        "747519": "C4,C5,C8,C10,C14,C15,C31,C37-43,C45",
        "697433": "C7,C9,C22,C23",          # 'CF, 9» 22;' / 'Cc 23' -- 'CF' is C7
        # 'K 1-5, 10,' / 'K 11, 13, i15=' / 'K 18, 20, 22-' / 'K 27, 31'. The
        # 'i15=' is 'K 15-', so without this K15-K17 are lost from the 2 form C
        # row and the Tot Qty of 20 stops matching.
        "769307": "K1-5,K10,K11,K13,K15-18,K20,K22-27,K31",
        "816090": "TP1,TP2,TP5-TP20",       # 'TP 1, 2, 5S-' / 'TP 20' -- '5S' is 5
        # 'Ril  RES,CC,330,+-5%,1W' -- R11's second 1 reads as an l, which the
        # row parser drops, so the row arrives as a bare R1. R1 is a real and
        # different part on this board (10k, stock 697102), exactly the A12 case.
        # Note this row is also a genuine revision difference: Rev 9 has R11 as
        # a carbon-composition GB3311, the 1996 list as a metal-oxide A52R.
        "163394": "R11",
        # 'Ui1 ad  IC,CMOS,PROGRMBL PERIPHERAL INTERFACE' -- the 82C55 is U11,
        # and the garbled field resolves to U1, which is one of three OP-07s.
        "780650": "U11",
    },
    "a6": {
        # Not an OCR artefact: the Rev 9 page really prints
        # 'R 40, 48, 74- / R 78,102,110, ...' as ONE row, with one description
        # (RES,MF,866), one stock number (816603) and a Tot Qty of 33 -- and it
        # carries no 697102 row at all. The 1996 list has the two separately,
        # R48 alone as the 866 ohm metal film (816603, qty 1) and R40 with
        # R74-78, R102 and twenty-five more as 10K carbon film (697102, qty 32),
        # and 32 + 1 = 33 is where the merged quantity comes from. Sheet 1
        # settles it: it prints 10K beside R40 and 866 beside R48.
        #
        # Left alone the merge gave thirty-two 10K resistors an as-built row
        # claiming they were 866 ohm 50 ppm metal film -- the one shape of error
        # that reads as authoritative. Pinning the row to R48 keeps R48's
        # manufacturer columns and leaves the other thirty-two with the 1996
        # description and no as-built row, which is the honest outcome: the
        # Rev 9 list does not name them. See the 'R40/R48' caveat in
        # data/a6.reference.json.
        "816603": "R48",
        # 'R 201,201,301,' against a Tot Qty of 5 -- R101's 1 read as a 2. R201
        # is a real and different part on this board (49.9 ohm metal film, stock
        # 820266), so no designator-keyed fix can tell the two apart, and left
        # alone R101 is the only 220 ohm carbon comp with no as-built row while
        # R201 gains one it never had.
        "186031": "R101,R201,R301,R401,R501",
        # '21  RES,CERM,SIP,10 PIN,9 RES,10K' -- Z1's Z read as a 2, which
        # leaves a bare number with no prefix in scope and expands to nothing.
        "414003": "Z1",
    },
    "a7": {
        # 'Ril, 13, 81, / R 82' -- R11's second 1 reads as an l, which the row
        # parser drops, so the row arrives as a bare 'R1'. R1 is a real and
        # different part on this board (1K carbon film, stock 780585), so no
        # designator-keyed fix can tell the two apart -- the same case as A12's
        # R11 and A9's. Read off .build/a7/ocr/p31.png at 400 dpi: the page
        # prints 'R 11, 13, 81, / R 82' against a Tot Qty of 4.
        #
        # Correcting it also exposes the genuine disagreement underneath, which
        # a false R1 was hiding: Rev 9 puts R81 and R82 on stock 820308 and
        # calls the whole row 1K, while the 1996 list has R11/R13 as 909 ohm on
        # 820308 and R81/R82 as 1K on 816595 -- and Rev 9's own schematic sheet
        # 2 prints 909 beside R11 and R13. See the 'R11/R13' caveat.
        "820308": "R11,R13,R81,R82",
    },
}

# The 1996 list has a real text layer, so nothing here is an OCR artefact --
# these are typesetting errors in the printed table, and the Rev 9 list is what
# settles each one. Keyed by assembly and then by Fluke stock number, because
# that field is right in both revisions even where the designator column is not.
#
# The failure mode this exists for is quiet. A designator the 1996 list never
# names is not in `parts`, so when the Rev 9 row joins on stock number the merge
# has nothing to attach it to and skips it -- no BOM line, no unplaced count, no
# review line. The part is simply not on the board as far as the dataset knows.
PARTS_1996_ROW_FIXES = {
    "a13a1": {
        # 'CR4-6,CR9,C10  DIODE,SI,...,DUAL,SOT-23' against a Tot Qty of 5. The
        # fifth is CR10: the drawing and the sheet both print CR10 (the second
        # BAV99 in the mid stage bias chain), and C10 is the 1000 pF capacitor
        # on its own row two lines up. Rev 9 prints 'CR 4- 6, 9 / CR 10'. Left
        # alone, the row overwrote C10's description with the diode's.
        "742320": "CR4-6,CR9,CR10",
        # 'Q2,Q4,Q5  TRANSISTOR,SI,NPN,SMALL SIGNAL' against a Tot Qty of 4.
        # Rev 9 prints 'Q2, 4, 5, / Q7' for the same MMBTH10 and the same
        # quantity, and the sheet draws Q7 as an MMBTH10 driving the output
        # stage's positive side.
        "845438": "Q2,Q4,Q5,Q7",
    },
    "a5": {
        # 'L1-6,L18,L123-128  CHOKE,6TURN' against a Tot Qty of 7. The quantity
        # is the tell: L1-L6 and L18 are seven parts, and L123-L128 would make
        # thirteen. Rev 9 prints the same row, same stock number, as 'Li1- 6, 18'
        # for a Tot Qty of 7 -- no L123-L128 at all -- and lists positions
        # 123-128 separately as 'R 123-128  RES,CF,10,+-5%,0.25W' stock 807669,
        # Tot Qty 6. The board silkscreen says R123-R128 and sheet 3 draws them
        # as the 10 ohm resistors in the K2/K3/K5-K9 coil returns, hand-lettered
        # like the ECO they are. So the L123-128 in this field is a typesetting
        # error, and left standing it invented six chokes that are on no drawing
        # while the six resistors that are stayed missing.
        #
        # The 1996 row's own footnote still reads "L123, L124- alternate PN
        # 452888 if there is difficulty meeting 30 MHz specificaiton", and the
        # photographed board has 6-turn chokes fitted at those pads rather than
        # resistors. That is a real four-way disagreement about what belongs
        # there, not something to resolve here; see the 'R123-R128' caveat in
        # data/a5.reference.json.
        "320911": "L1-6,L18",
    },
    "a4": {
        # 'MP11  RIVET,S-TUB,OVAL,AL,.087,.343  838458  2' -- one designator
        # against a Tot Qty of 2. The missing one is MP12: Rev 9 prints
        # 'MP 3- 12' for a Tot Qty of 10, so it names an MP12 the 1996 row does
        # not, and MP19 exists in neither list. Restoring it makes the Tot Qty
        # agree and gives MP12 the description this revision built it with --
        # the .343 aluminium rivet -- with Rev 9's consolidation onto the .250
        # steel rivet recorded as its as-built row rather than as its only row.
        "838458": "MP11,MP12",
    },
    "a13": {
        # 'R19,R37,R50' against a Tot Qty of 5. Rev 9 prints the same row, same
        # stock number, as 'R 19, 37, 50, / R 70, 79' -- five designators for a
        # Tot Qty of 5. R70 and R79 are on sheet 2, in the zero crossing
        # detector (R70 from INT OSC OUT, R79 in the second multiplier).
        "697102": "R19,R37,R50,R70,R79",
        # 'R89,R90,R9, R98' at 10 ohms, Tot Qty 4 -- but R9 is already a 200 ohm
        # part two rows up in the same table, and the drawing has no second R9.
        # Rev 9 prints 'R 89, 90, 97, / R 98'. The board silkscreen and sheet 2
        # both show R97 as the 10 ohm emitter resistor beside Q15, so the 1996
        # row has simply lost the 7. Left uncorrected this also produced the
        # 'duplicate designator R9' review line, with the 10 ohm description
        # overwriting the 200 ohm one.
        "807669": "R89,R90,R97,R98",
    },
    "a20": {
        # Not a scanning fault -- the 1996 text layer is exact here -- but a row
        # the table's own layout breaks. U15 is the only part in any of these
        # parts lists whose stock number is not a number: the 5700A and the
        # 5720A take different flash devices, so the column reads "See Note 1"
        # and the note underneath gives 1608184 and 1619757. ROW_1996 wants six
        # or seven digits there, so the row does not parse, and its wrapped
        # second line -- "BOOT,PROGRAMMED,SO44,TAPE", the tail of the
        # description -- is then read as more designators for the row above it,
        # which is U13's. Pinning U13's designator field puts that right.
        #
        # The Series II flash U15 itself stays out of the BOM. That is the
        # honest outcome rather than a loss: this instrument is the through-hole
        # build, where U15 is an EPROM, and the Rev 9 list supplies it (stock
        # 761262, 'EPROM,PROGRAMMED 27010,A20U015'). See the 'u15' caveat in
        # data/a20.reference.json for the two Series II part numbers.
        "1588978": "U13",
    },
}

# Stock numbers the scan corrupts, corrected before anything is joined on them.
# Six and seven digit numbers both occur, so a stray digit glued to a six-digit
# number now reads as a plausible seven-digit one and cannot be spotted by its
# length. The row's own continuation line is what settles it.
REV9_STOCK_FIXES = {
    "a6": {
        # 'g1  CONN,COAX,SMB(M),PWB,RT ANG  1353243 98291 |051-053-0000-220' --
        # the column rule ahead of the stock number reads as a 1, and six- and
        # seven-digit stock numbers both exist, so the length says nothing. The
        # page prints 353243, which is also what the 1996 list has; without this
        # J1 -- the coax connector §5-5 steps 11 to 14 tell you to unplug --
        # fails to join and loses its manufacturer part number.
        "1353243": "353243",
    },
    "a13": {
        # 'R 29, 62, 68  RES,MF,10K,+-1%,0.125W,100PPM  " 1658914 | 89536 1658914 3'
        # -- a ditto mark ahead of the number reads as a 1, and six-digit and
        # seven-digit stock numbers both exist, so the length says nothing. The
        # page prints 658914, which is also what the 1996 list has; without this
        # the row fails to join and R29/R62/R68 gain an asBuilt entry claiming a
        # revision change that did not happen.
        "1658914": "658914",
    },
    "a15": {
        # 'R 23, 24, 60,  RES,CF,10,+-5%,0.25W  "1572941 | 59124 |cFr1-41000B  4'
        # continues on the next line as 'R 65   572941'. The ditto mark before
        # the number is read as '"1', so the first line gains a leading 1 that
        # the continuation does not have. 572941 also sits with this board's
        # other resistor stock numbers -- 572941, 573212, 573311, 573378, 573451.
        "1572941": "572941",
    },
}

# The manufacturer supply code and part number, for rows where the scan lost the
# column rule between them and the split went wrong. Keyed by assembly and stock
# number; the value is (supply code, part number) read off the page. A garbled
# part number is worse than a missing one -- the app shows it, and someone will
# order from it -- so these three are corrected rather than left to stand.
REV9_MFR_FIXES_BY_STOCK = {
    # Every value below was read off .build/a4/ocr/p20.png at 400 dpi -- the
    # printed page, not the OCR of it.
    "a4": {
        # The one that matters. Chapter 6's footnote 1 repeats this stock number
        # in a sentence, and the row parser reads that sentence as a row; the
        # merge then joins it to F1 on stock number and replaces F1's
        # manufacturer part with "is for 100-120 volt configuration. For 200-230
        # volt configuration". Fixing the row by stock number covers both the
        # real row and the footnote, so whichever lands last is right. The page
        # prints 71400 / MDL-3 -- a Bussmann 3 A slow-blow, which is what the
        # 3.0A SLO annotation on schematic sheet 1 says too.
        "109280": ("71400", "MDL-3"),
        # 'SR211A6820AA nil' -- the J tolerance suffix (+-5%, which the
        # description states outright) read as a 0, and the Tot Qty column read
        # as 'nil', which is a character too long for clean_mfr_part to trim.
        "816710": ("04222", "SR211A682JAA"),
        "698555": ("04713", "1N4002RL"),        # 'IN4002RL' -- leading 1 as I
        "414532": ("59124", "CF1-4680J"),       # 'CF1-46800' -- the J as a 0
        "519355": ("09214", "V275LA15AS14K275"),  # 'v275LA15AS14K275'
        "886697": ("31918", "FN01NEETBN4101BAG"),  # 'FNOINEETBN4101BAG'
        "358341": ("28213", "SJ-5003"),         # 'sJ-5003'
    },
    "a13": {
        # '810390 §9124 |CF1-4VvT2017' -- the rule before the supply code read
        # as a section mark, so the code was never recognised and the whole
        # tail became the part number. The page prints 59124 / CF1-4VT201J.
        "810390": ("59124", "CF1-4VT201J"),
        # '866769  04713 |MRF545' -- rule lost after the stock number.
        "866769": ("04713", "MRF545"),
        # '775296 | 89536 1775296' -- the rule ahead of the part number read as
        # a 1, the same confusion REV9_STOCK_FIXES corrects for R29 above.
        "775296": ("89536", "775296"),
        # '658914 | 89536 1658914' -- same leading 1, and keyed by the stock
        # number after REV9_STOCK_FIXES has corrected it.
        "658914": ("89536", "658914"),
    },
    # A9's manufacturer part numbers are the worst-scanned column on this board:
    # eighteen of its thirty-nine rows come back corrupted, and they corrupt in
    # ways that still look like part numbers. The tolerance suffix 'J' reads as
    # '7', 'T7' or 'T9' on every carbon-film resistor, and the '50' of the metal
    # film series reads as 'SO'. Every value below was read off .build/a9/ocr/
    # p37.png and p38.png at 400 dpi -- the printed page, not the OCR of it.
    "a9": {
        "816181": ("04222", "SR171C102MAA"),        # 'SR171C1LO2MAA'
        "747519": ("60935", "185.22/J/0050/R/C/B"),  # '185.22/7/0050/R/C/B'
        "807644": ("56289", "199D475X0025BA1"),     # '199D475xX0025BA1'
        "697102": ("59124", "CF1-4VT103J"),         # 'CF1-4VT1037'
        "780585": ("59124", "CF1-4VT102J"),         # 'CF1-4VT1027' / 'CF1-4VT102T9'
        "822189": ("59124", "CF1-4VT470J"),         # 'CF1-4VT470T7'
        "658963": ("59124", "CF1-4VT104J"),         # 'CF1-4VT1047'
        "810465": ("59124", "CF1-4VT101J"),         # 'CF1-4VT1017'
        "817528": ("59124", "CF1-4VT240J"),         # 'CF1-4vVT2407'
        "658955": ("59124", "MF50DVT1002B"),        # 'MFSODVT1002B'
        "851332": ("59124", "MF50CVT763B"),         # 'MFSOCVT763B'
        "747535": ("59124", "CF55VT223J"),          # 'CF55vVvT2237'
        "658914": ("59124", "MF50DVT1002F"),        # 'MFSODVT1002F'
        "810390": ("59124", "CF1-4VT201J"),         # 'CF1-4VT201T7'
        "714303": ("59124", "CF1-4VT163J"),         # 'CF1-4VT1637'
        "605980": ("06665", "OP-07DP"),             # 'OP-0O7DP'
        "810952": ("64155", "LT1052CN/FLOW 52"),    # 'LT1LO5S2CN/FLOW 52'
        "782912": ("56289", "UCN5801A"),            # 'UCNS801A'
        "741199": ("04713", "MC74HCU04N"),          # 'MC74HCUO0D4N'
        "408310": ("91637", "CSC10A-03-101G"),      # 'CSC1OA-03-101G'
    },
    "a10": {
        # '769307 | 61529 |DS2EML2DCS5VCH2 84  20' -- the part number is wider
        # than its column, so the page wraps '84' toward the Tot Qty field and
        # the OCR both loses it and inserts an S. The page prints
        # DS2EML2DC5VCH284, the Matsushita/NAIS part silkscreened on all 20 of
        # these relays in the photograph.
        "769307": ("61529", "DS2EML2DC5VCH284"),
        # '782912 56289 JUCN-5801A' -- the column rule ahead of the part number
        # read as a J. A11's copy of the same Sprague driver reads UCN5801A.
        "782912": ("56289", "UCN-5801A"),
        # 'CF1/4 2717' and 'CF1/4 1017' -- the J tolerance suffix (+-5%, which
        # the description states outright) read as a 7 on both carbon film
        # rows. The page prints CF1/4 271J and CF1/4 101J.
        "810424": ("59124", "CF1/4 271J"),
        "810465": ("59124", "CF1/4 101J"),
        # '199D106xX0035DG2' -- a duplicated x before the real X, and
        # '199D475x0025BE2' -- the same X read in lower case. Sprague 199D
        # tantalum coding uses a capital X for the tolerance letter.
        "816512": ("56289", "199D106X0035DG2"),
        "807644": ("56289", "199D475X0025BE2"),
    },
}

# Characters the scan produces in place of a designator prefix letter.
REV9_CHAR_FIXES = str.maketrans({"©": "C", "¢": "C", "®": "R", "§": "S"})

DESIGNATOR_PREFIXES = (
    "CR", "VR", "RT", "MP", "TP", "SW", "C", "R", "Q", "U", "Z", "F", "J", "K", "H", "P",
    "S", "W", "L", "T", "X", "Y", "HR", "M", "HS",
    # A11 brings A: its parts list gives the two plug-in SIP daughter boards
    # their sub-assembly designators, 'A1  DAC FILTER SIP PCA' and 'A2  DAC
    # BUFFERED REFERENCE SIP PCA'. They are A11A1 and A11A2 elsewhere in the
    # manual, and without the prefix both rows are dropped from the BOM without
    # a word -- which would leave the board's two most substitutable parts
    # unsearchable.
    "A",
    # A7 brings E: 'E1,E2  JUMPER,WIRE,NONINSUL,0.200CTR', the two wire links
    # that §5-7 step 1 and §5-8 step 6 tell you to CUT in order to break the
    # current feedback loop and the phase-locked loop. They are the same part as
    # the board's test points (stock 816090) and they are printed on the drawing
    # and on sheets 1 and 4. Without the prefix both rows are dropped from the
    # BOM in silence -- and these are the two parts the procedure destroys.
    "E",
    # A5 brings CP. Its three entries are the
    # accessories the wideband option ships with rather than parts of the board
    # -- 'CP1 ADAPTER,BNC(F),BANANA PLUG(M)', 'CP2 ADAPTER,COAX,BNC(M),N(F)',
    # 'CP3 POUCH,TEST LEAD'. They have no silkscreen and belong in notOnDrawing,
    # but they are orderable items with stock numbers and §5-4 step 9 cannot be
    # run without the N-type hardware, so dropping them in silence would take
    # the option's own accessories out of the parts list.
    "CP",
    # A4 brings RV: 'RV1 VARISTOR,22V' and 'RV2 VARISTOR,430V', the two metal
    # oxide varistors on the backplane. RV2 sits directly across the ac line
    # behind the fuse and RV1 across the transformer primary shield network, so
    # they are the board's transient protection and among the few parts on it
    # that fail. Without the prefix, split_prefix rejects 'RV1' outright and
    # both rows are dropped from the BOM in silence -- and a shorted mains
    # varistor is exactly the fault that presents as a blown line fuse.
    "RV",
    # ...and XU. A17's IC sockets are X1, X2; A7's are named after the IC they
    # hold, 'XU1,XU2  SOCKET ,SOCKET,IC,8 PIN'. Without the prefix the whole
    # row is an unparsed field and both sockets vanish from the BOM -- which
    # matters more here than usual, because they are the only statement anywhere
    # in the manuals that two of this board's ICs can be swapped without a
    # soldering iron.
    "XU",
    # A20 brings three, all of them on the clock/calendar corner of the board.
    # BT is the lithium cell that backs up the real-time clock -- 'BT1
    # BATTERY,LITHIUM,3.0V,0.500AH' in the Rev 9 list, soldered to the board on
    # the photographed instrument, and the subject of its own published
    # procedure (4-21). DS is the reset indicator on the Series II board, 'DS1
    # LED,RED,BR1101W'; the through-hole board calls the same lamp CR1. XBT is
    # the Series II coin-cell holder that replaced the soldered BT1,
    # 'XBT1 CONNECTOR,HOLDER,BATTERY,2450 COIN'. Without the prefixes all three
    # rows are dropped from the BOM in silence -- and BT1 is the one part on
    # this assembly the manual expects to be replaced in service.
    "BT", "DS", "XBT",
)

KIND_BY_PREFIX = {
    "C": "cap", "R": "res", "CR": "diode", "VR": "zener", "Q": "transistor",
    "U": "ic", "Z": "resnet", "F": "fuse", "J": "jumper", "K": "relay",
    "TP": "testpoint", "MP": "mech", "H": "mech", "P": "connector",
    "S": "switch", "SW": "switch", "RT": "thermistor", "W": "wire",
    # A17 introduces five families A18 has no examples of. X is an IC socket,
    # which is mechanical in the sense that matters here: it has no silkscreen
    # designator of its own, it sits under the IC it holds.
    "L": "inductor", "T": "transformer", "Y": "crystal", "X": "socket",
    # A15 brings HR: a hybrid op amp bonded to a precision resistor network.
    # The schematic prints it as "HR7 RNET 70K 7M" inside the "4HR7 ASSY (4R20
    # RNET)" block, so it is filed with the resistor networks rather than the
    # ICs -- what fails on it is the ratio, and that is what you replace.
    "HR": "resnet",
    # A16 also brings M, which is a real family and not a mis-split of MP: the
    # 1996 list uses it manual-wide for sheet-metal shields and covers (M2-M5 on
    # the Wideband boards, M2/M3 on the DAC, M4 on Ohms Cal, M12 on A12). A16's
    # single entry, M17 OSCILLATOR THERMAL COVER, is stock 797696 -- the very
    # same part A12 carries as M12. It is a cover, so it takes the same 'mech'
    # kind as MP and H and needs no new label in js/app.js.
    "M": "mech",
    # A11's A1/A2 are whole plug-in PCAs, not components. Nothing in the kind
    # legend describes a daughter board, and inventing one would mean a new
    # colour and a new label in js/app.js for two parts; 'part' is the legend's
    # own catch-all and is what they are -- a replaceable item with a stock
    # number that is none of the other kinds.
    "A": "part",
    # A12 brings HS: 'HS1  HEAT DIS,RAD,.54X1.25X.35,TO-8', the radial heat sink
    # clipped over the TO-8 thermal sensor. Without the prefix, expand_designators
    # cannot parse the token and the row is reported as an unparsed field rather
    # than becoming a part. It is a heat sink, so it takes the same 'mech' kind as
    # MP, H and M and needs no new label in js/app.js.
    "HS": "mech",
    # A7 brings E: its E1 and E2 are wire links, the same stock number and the
    # same 'JUMPER,WIRE,NONINSUL' description as the board's test points, so
    # they take the existing 'jumper' kind that J already uses and need no new
    # label in js/app.js.
    "E": "jumper",
    # ...and XU, which is A17's X by another name: an IC socket, with no
    # silkscreen designator of its own, sitting under the IC it holds.
    "XU": "socket",
    # A5's CP1-CP3 are the wideband option's supplied accessories -- two coaxial
    # adapters and the pouch they live in. Nothing in the kind legend describes
    # a loose accessory, and inventing one would mean a new colour and a new
    # label in js/app.js for three items that are never on the board; 'part' is
    # the legend's own catch-all ("Other") and is exactly what they are. They
    # are carried in notOnDrawing alongside MP1, the 50 ohm N-type termination,
    # and W2, the output cable, which are the same kind of thing under older
    # prefixes.
    "CP": "part",

    # A20's three. 'battery' and 'led' are genuinely new kinds and take a colour
    # and a label in js/app.js: sending BT1 to the 'part' catch-all would file
    # the one consumable on the board under "Other", and sending DS1 to 'diode'
    # would colour the reset lamp like the four Schottky diodes beside it, which
    # is the part you look at first when the instrument will not boot. XBT needs
    # no new kind -- the parts list's own leading field for it is CONNECTOR, and
    # a battery holder is a contact carrier, so it goes with P61/P62 rather than
    # to 'socket', whose card label reads "IC socket" and would be a lie.
    "BT": "battery",
    "DS": "led",
    "XBT": "connector",
    # A4 brings RV, and it needs a kind of its own. A varistor is a voltage-
    # dependent resistor, but filing it as 'res' would hand Parts.spec() the
    # description 'VARISTOR,22V,+-20%,1.0MA' and get back a 22 ohm resistor with
    # a +-20% tolerance -- a wrong parse, which the pitfalls call worse than a
    # declined one. 'thermistor' is the wrong device and 'part' ("Other") hides
    # the two components on a mains-carrying backplane that most deserve to be
    # findable. So 'varistor' is added to the three label/colour maps in
    # js/app.js alongside this entry.
    "RV": "varistor",
}

# One prefix, two different parts. A15's HR7 is printed "HR7 RNET 70K 7M" and
# is a resistor network with an op amp bonded to it; A16's HR8 is "POWER AMP DC
# HYBRID", an op amp with two networks bonded to it. Neither board should be
# made to lie about its own part to keep a single global map, and there is no
# 'hybrid' kind in js/app.js to send both to, so the shared map keeps A15's
# reading and A16 overrides its own prefix here.
KIND_BY_PREFIX_BY_ASM = {
    "a16": {"HR": "ic"},
    # A11's two are the same case: "HR5 REFERENCE HYBRID ASSY" is the reference
    # the instrument's absolute accuracy rests on, and "HR6 DC AMP HYBRID ASSY"
    # is an amplifier. Calling either a resistor network on the info card told
    # the reader the wrong thing about the most important part on the board --
    # and META["a11"] already describes HR5 as the instrument's accuracy, so the
    # dataset's own prose disagreed with its label.
    "a11": {"HR": "ic"},
    # A5's three J's are all connectors and none of them is a jumper: J1 and J2
    # are the right-angle SMB coaxial connectors that carry the 1.2-30 MHz input
    # from A6 and the 10 Hz-30 MHz output to the front panel, and J3 is the
    # 2-pin header that E3 plugs onto. The board's actual jumper is E3 itself,
    # which already takes the 'jumper' kind through the E prefix A7 introduced.
    # Leaving the shared map's reading would have labelled the option's two
    # coaxial connectors "Jumper" on their own info cards.
    "a5": {"J": "connector"},
    # A4's J family is not a jumper anywhere on the board. Every one of its
    # thirteen J designators is a connector -- 'HEADER,1 ROW,.156CTR,12 PIN',
    # 'CONN,DIN41612,TYPE C,64 SCKT', and the two fibre-optic ends J73 and J74
    # -- and this backplane is nothing but connectors, so labelling them
    # "Jumper" would mislabel a quarter of the BOM. The shared map keeps J as
    # 'jumper' for the boards that use it that way; A4 overrides its own.
    "a4": {"J": "connector"},
}

# Designators the Rev 9 list names, the 1996 list does not, and a person has
# confirmed against the drawing and the schematic.
#
# rev9_only_is_plausible() rejects a Rev-9-only designator numbered past
# anything the 1996 list uses for that prefix, because that is what a scan
# running two designators together produces. Its docstring says genuine
# additions always sit inside the existing numbering; A5 is the counter-example.
# Table 6-6's resistors stop at R122, and R123-R128 are six real 10 ohm parts:
# Rev 9 prints them as one clean row ('R 123-128  RES,CF,10,+-5%,0.25W  807669'
# against a Tot Qty of 6), the board silkscreens all six, and sheet 3 draws each
# one in series with a relay coil -- R123 with K8, R124 with K7, R125 with K6,
# R126 with K5, and R127/R128 with K9 and K3. Dropped, they left five relay coil
# returns with nothing in them and the coverage badge counting six silkscreened
# designators as parts that do not exist.
#
# Listing them by name rather than relaxing the rule keeps the rule doing its
# job everywhere else: this is a statement that someone looked, not a wider net.
#
# A20 breaks the same assumption for a different reason, and more thoroughly.
# The rule takes both parts lists to describe one board; on A20 they do not.
# The 1996 list is the surface-mount Series II build and the Rev 9 list the
# through-hole one, and the through-hole board -- which is what the locator, the
# photograph and the instrument itself are -- simply carries parts the later
# build dropped. Every A20 entry was checked against Photos/a20_top.jpg and
# Figure 7-24: T51 and R82 are legible on both, MP1/MP2 are the two ejector
# ears, MP7/MP8 the adhesive pads.
REV9_ONLY_CONFIRMED = {
    "a5": {"R123", "R124", "R125", "R126", "R127", "R128"},
    "a20": {"MP2", "MP7", "MP8", "R81", "R82", "T51"},
}


def run_text(pdf, out):
    """pdftotext -layout, cached."""
    if not os.path.exists(out):
        os.makedirs(os.path.dirname(out), exist_ok=True)
        subprocess.run(["pdftotext", "-layout", pdf, out], check=True)
    return open(out, encoding="utf-8", errors="replace").read().split("\n")


def run_ocr(pdf, page, build):
    """Extract one page at native resolution, rotate upright, OCR it. Cached."""
    base = os.path.join(build, "ocr", "p%d" % page)
    txt = base + ".txt"
    if os.path.exists(txt):
        return open(txt, encoding="utf-8", errors="replace").read().split("\n")
    os.makedirs(os.path.dirname(base), exist_ok=True)
    subprocess.run(["pdfimages", "-f", str(page), "-l", str(page), "-png", pdf, base + "raw"],
                   check=True)
    raw = base + "raw-000.png"
    subprocess.run(["magick", raw, "-rotate", "270", base + ".png"], check=True)
    os.remove(raw)
    subprocess.run(["tesseract", base + ".png", base, "--psm", "6"],
                   check=True, stderr=subprocess.DEVNULL)
    return open(txt, encoding="utf-8", errors="replace").read().split("\n")


# --------------------------------------------------------------------------
# designator handling
# --------------------------------------------------------------------------

def rev9_only_is_plausible(ref, parts, asm=None):
    """
    Would this designator fit on this board at all?

    A Rev-9-only part is created from OCR alone, with no 1996 row to confirm it,
    so a misread invents a component rather than corrupting one -- and an
    invented component can never be placed, which quietly makes the coverage
    badge lie. The tell is the number: the scan runs two designators from one
    row together, so A14 gains a 'C1214' from 'C12' and 'C14' where its
    capacitors stop at C33, and A17 a 'Z521' from 'Z51, 52' where its stop at
    Z54. Genuine additions -- A11's K6 and K7, A16's VR8 and VR9 -- always sit
    inside the numbering the 1996 list already uses.

    Judged only against parts the 1996 list vouches for, so one bad row cannot
    widen the range for the next -- except where someone has checked the
    designator against the drawing and said so in REV9_ONLY_CONFIRMED.
    """
    if ref in REV9_ONLY_CONFIRMED.get(asm, ()):
        return True                 # confirmed by eye; see REV9_ONLY_CONFIRMED
    split = split_prefix(ref)
    if not split:
        return True                     # not our shape; leave the caller's rules alone
    prefix, num = split
    # Nothing is designator zero. A13's Rev 9 row reads 'U 5, 7, 11, 0', where
    # the trailing 0 is the ESD-marker column bleeding into the designator
    # field -- the same artefact OCR_DESIGNATOR_FIXES corrects by hand on A11,
    # A14 and A16. Left alone it shipped a 'U0  iad RES NET HYBRID,TESTED'
    # that can never be placed.
    if num == 0:
        return False
    seen = [split_prefix(r)[1] for r, p in parts.items()
            if p.get("src") != "Rev 9 only" and split_prefix(r)
            and split_prefix(r)[0] == prefix]
    if not seen:
        return True                     # a prefix new to this board, e.g. A16's A1
    return num <= max(seen)


def split_prefix(token):
    """'CR251' -> ('CR', 251).  '253' -> ('', 253).  Returns None if unparseable."""
    m = re.match(r"^([A-Z]*)(\d+)$", token)
    if not m:
        return None
    prefix, num = m.group(1), int(m.group(2))
    # The Rev 9 scan renders 'C' as 'Cc' often enough to be worth collapsing a
    # doubled leading letter before giving up on the token.
    if prefix and prefix not in DESIGNATOR_PREFIXES and len(prefix) == 2 \
            and prefix[0] == prefix[1]:
        prefix = prefix[0]
    if prefix and prefix not in DESIGNATOR_PREFIXES:
        return None
    return prefix, num


def normalize_designator_field(text):
    """Uppercase, drop OCR junk characters, and close up 'CR 201' -> 'CR201'."""
    t = text.upper().replace("~", "-")
    t = re.sub(r"[^A-Z0-9,\-\s]", " ", t)     # '©', '¢', '|', ';' are all noise
    t = re.sub(r"\s*-\s*", "-", t)            # 'C 7- 9' -> 'C 7-9'
    t = re.sub(r"([A-Z])\s+(?=\d)", r"\1", t)  # 'CR 201' -> 'CR201'
    t = re.sub(r"[\s]+", ",", t)              # remaining spaces separate entries
    return re.sub(r",+", ",", t).strip(",")


def expand_designators(text):
    """
    Turn a parts-list reference field into an explicit designator list.

    Handles the forms the manuals actually use: 'C1,C10,C17', 'C7-9,C18',
    'TP1-22,TP203,TP205-212', 'CR244,CR251-253', 'R2-5', 'CR5 CR8' (the 1996
    list drops a comma there), and continuation ranges that were split across
    two printed lines ('CR244,CR251-' + '253').
    """
    t = normalize_designator_field(text)
    out, errors, prefix = [], [], ""
    for token in t.split(","):
        if not token:
            continue
        if "-" in token:
            lo_s, _, hi_s = token.partition("-")
            lo, hi = split_prefix(lo_s), split_prefix(hi_s)
            if not lo or not hi:
                errors.append(token)
                continue
            prefix = lo[0] or prefix
            # 'TP205-212' and 'C7-9': the high end may omit the prefix, and may
            # also omit leading digits ('CR251-253' vs 'C7-9' both work here).
            hi_num = hi[1]
            if hi[0] and hi[0] != prefix:
                errors.append(token)
                continue
            if hi_num < lo[1]:
                errors.append(token)
                continue
            out.extend("%s%d" % (prefix, n) for n in range(lo[1], hi_num + 1))
        else:
            parsed = split_prefix(token)
            if not parsed:
                errors.append(token)
                continue
            prefix = parsed[0] or prefix
            if not prefix:
                # A bare number with no prefix in scope. This happens when the
                # scan corrupts the prefix letter of the row's first token and
                # the fix table has not caught it -- A11's 'G59, 67' is C59 and
                # C67 -- and it used to emit a "designator" literally named 67.
                # Harmless while such a ref could only fail to join, but a part
                # named 67 is now creatable, so say it is unparsed instead.
                errors.append(token)
                continue
            out.append("%s%d" % (prefix, parsed[1]))
    return out, errors


def join_designator_chunks(chunks):
    """Rejoin a reference field printed across several lines."""
    text = ""
    for chunk in chunks:
        chunk = chunk.strip()
        if not chunk:
            continue
        if not text:
            text = chunk
        elif text.endswith("-") or text.endswith(","):
            text += chunk
        else:
            text += "," + chunk
    return text


def kind_of(ref, asm=None):
    m = re.match(r"^([A-Z]+)", ref)
    if not m:
        return "part"
    prefix = m.group(1)
    override = KIND_BY_PREFIX_BY_ASM.get(asm, {}).get(prefix)
    return override or KIND_BY_PREFIX.get(prefix, "part")


# --------------------------------------------------------------------------
# 1996 parts list (text layer)
# --------------------------------------------------------------------------

ROW_1996 = re.compile(
    r"^\s*(?P<desig>[A-Z][A-Z0-9,\- ]*?)"
    r"\s{2,}(?P<esd>\*\s+)?"
    r"(?P<desc>\S.*?)"
    # Fluke stock numbers are six digits on the original parts and seven on the
    # later ones. A16 has three seven-digit rows -- K12/K17, Q12/Q14 and MP5-6 --
    # and a six-digit-only pattern does not merely mistrim them, it fails the
    # whole line and drops the row without a word.
    r"\s{2,}(?P<fluke>\d{6,7})"
    r"(?:\s+(?P<qty>\d+))?"
    r"(?:\s+(?P<notes>\S.*?))?\s*$"
)
CONT_1996 = re.compile(r"^\s*(?P<desig>[A-Z]?[A-Z0-9,\- ]*?)\s*(?:\*\s*)?(?:\d{6,7})?\s*$")


def parse_parts_1996(lines, title):
    """Parse every page of the assembly's parts table into rows.

    `title` is normally one heading, and the table's continuation pages repeat
    it with "(cont)" appended. A20 is the exception: its table runs over two
    pages and the manual numbers the second one afresh, so page 6-82 is headed
    "Table 6-25. A20 CPU PCA" and page 6-83 "Table 6-26. A20 CPU PCA (cont)".
    A19's and A21's continuations reuse their own numbers, so this is a
    numbering mistake in the manual rather than a second table -- but a single
    title stops the scan dead at the 6-26 heading and drops fourteen rows,
    including the SRAM, the DUART, the real-time clock and the battery holder,
    without a word. So a list of headings is accepted and any of them keeps the
    scan open.
    """
    titles = [title] if isinstance(title, str) else list(title)
    rows, current = [], None
    in_table = False
    for line in lines:
        stripped = line.strip()
        if any(t in stripped for t in titles):
            in_table = True
            continue
        if not in_table:
            continue
        # A different table, or the illustration that closes the section.
        if stripped.startswith("Table 6-"):
            break
        if stripped.startswith("Figure 6-"):
            break
        if not stripped:
            continue
        # Skip repeated column headers and page furniture.
        if re.match(r"^(Reference|Designator|Description|No$|Stock|Fluke|Tot Qty|Notes|"
                    r"5700A|Service Manual|List of Replaceable|\d+-\d+$)", stripped):
            continue
        if re.match(r"^\d+\.\s", stripped):       # footnotes ("1. Q201, Q202- ...")
            if current:
                rows.append(current)
                current = None
            continue

        m = ROW_1996.match(line)
        # A continuation line carries designators, possibly an ESD asterisk, and
        # a repeated stock number -- nothing that qualifies as a description.
        desc_ok = bool(m) and len(re.sub(r"[^A-Z0-9]", "", m.group("desc").upper())) >= 3
        if m and desc_ok:
            if current:
                rows.append(current)
            current = {
                "desig_chunks": [m.group("desig")],
                "esd": bool(m.group("esd")),
                "desc": re.sub(r"\s{2,}", " ", m.group("desc").strip()),
                "fluke": m.group("fluke"),
                "qty": int(m.group("qty")) if m.group("qty") else None,
                "notes": (m.group("notes") or "").strip() or None,
            }
            continue

        # Continuation: more designators for the row already open.
        if current:
            cont = re.sub(r"\*", " ", line)
            cont = re.sub(r"\b\d{6,7}\b", " ", cont).strip()
            if cont and CONT_1996.match(cont):
                current["desig_chunks"].append(cont)
    if current:
        rows.append(current)
    return rows


# --------------------------------------------------------------------------
# Rev 9 parts list (OCR)
# --------------------------------------------------------------------------

# The scanned rows have no reliable column spacing, so instead of matching the
# whole line the parser anchors on the Fluke stock number -- an isolated 6-digit
# field that survives OCR -- and works outwards from it.
STOCK_RE = re.compile(r"(?<![\d.\-])(\d{6,7})(?![\d])")

def split_designators_from_description(left):
    """
    Split '<designators> [esd marker] <description>'.

    Column positions are not preserved by the scan, so the split is made at the
    first token whose *leading* run of letters is three or more characters
    ('CAP,AL,3.3UF', 'DIODE,SI,150', 'TRANSISTOR,'), or the two-letter 'IC,'
    that starts every regulator and comparator description. Designator tokens
    never look like that -- they are at most two letters before their digits --
    so the rule holds even where OCR has mangled the designators themselves.
    """
    tokens = left.split()
    for i, tok in enumerate(tokens):
        if i == 0:
            continue                       # the designator field is never empty
        lead = re.match(r"[A-Za-z]*", tok).group(0)
        if len(lead) >= 3 or lead.upper() == "IC":
            return " ".join(tokens[:i]), " ".join(tokens[i:])
    return left, ""


def clean_designator_tokens(desig):
    """
    Drop the ESD-marker column and OCR debris from a designator field.

    The marker sits after the designators and reads as '4', '*', '%' or a stray
    letter pair. A trailing single character is only a marker when the token
    before it does not end in ',' or '-': a real continuation of the list is
    always comma-joined ('C 4, 6' keeps the 6; 'Q 212 4' drops the 4).
    """
    def has_digit(toks):
        return any(re.search(r"\d", t) for t in toks)

    tokens = desig.split()
    out = []
    for i, tok in enumerate(tokens):
        # 'Ks', '*', '%' are never designators -- but only drop them while a
        # number remains elsewhere, so a wholly garbled 'CR is' survives intact
        # for the fix table to recognise.
        if i > 0 and not re.search(r"\d", tok) \
                and has_digit(tokens[:i] + tokens[i + 1:]):
            continue
        out.append(tok)
    # 'MP 2' and 'CR 5' are whole designators; dropping their only number would
    # leave a bare prefix, so a marker is only trimmed when a number remains.
    while len(out) > 1 and re.fullmatch(r"[0-9*%]", out[-1]) \
            and not out[-2].endswith((",", "-")) and has_digit(out[:-1]):
        out.pop()
    return " ".join(out)

# Right-hand side: '| 62643 |KME50VN332M30X30LLV 4', or 'COMMERCIAL 4'.
# The supply code is a CAGE code, which is alphanumeric ('0CLN7', '5W664',
# '7Z884') and not always five digits, so it is matched as a 4-5 character
# alphanumeric token that contains at least one digit. Requiring a digit is what
# keeps a genuine all-letter part number from being eaten as a code.
RIGHT_RE = re.compile(
    r"^[\s|\]}{;,)]*"
    r"(?:(?P<code>(?=[0-9A-Za-z]{4,5}(?![0-9A-Za-z]))[0-9A-Za-z]*[0-9][0-9A-Za-z]*)"
    r"\s*[|\]}{;/,]{0,2}\s*)?"
    r"(?P<part>.*?)"
    r"(?:\s+(?P<qty>\d{1,3}))?\s*$"
)


def clean_mfr_part(part):
    """Trim the OCR debris that collects around the manufacturer part column."""
    if not part:
        return None
    # A column rule sometimes reads as a letter glued to a separator ('j;1SOT1').
    part = re.sub(r"^[A-Za-z]?[|\]}{;/,]+", "", part)
    part = part.strip(" |]}{;/,)(=.")
    # The quantity column lands here when its own rule is missed; it is a short
    # run of digits, stray letters and punctuation at the end ('2 .', 'a | {').
    part = re.sub(r"\s+[A-Za-z0-9]{1,2}(\s*[|\]}{;/,.=]+\s*[A-Za-z0-9]?)?$", "", part)
    # ...and when it reads as pure punctuation plus a digit ('452888 =i').
    # The leading \s+ is what protects a real suffix: '6016B-1.25' has no space
    # before its '.25', so it is left alone.
    part = re.sub(r"\s+[=|\]}{;/,.‘’'`]+\s*[A-Za-z0-9]{0,2}$", "", part)
    return part.strip(" |]}{;/,)(=.") or None


def clean_rev9_left(left):
    """Undo the OCR confusions that occur in the designator/ESD columns."""
    left = left.translate(REV9_CHAR_FIXES)
    left = re.sub(r"^[^A-Za-z0-9]+", "", left)
    # 'l' and 'i' stand in for '1' in the designator column: 'Ri' -> 'R1'.
    left = re.sub(r"^([A-Za-z]{1,2})\s*[lIi](?=\s|,|$)", r"\g<1>1", left)
    left = re.sub(r"^([A-Za-z])[il](?=\d)", r"\1", left)     # 'Zi1-3' -> 'Z1-3'
    # The ESD asterisk sits in its own column between designators and
    # description, and the scan renders it as '4' more often than as '*'.
    left = re.sub(r"[,\s]\s*[4*%]{1,2}(?=\s+[A-Za-z]{2,})", " ", left)
    return left.strip()


def parse_parts_rev9(pages_lines, asm=None):
    stock_fixes = REV9_STOCK_FIXES.get(asm, {})
    rows, current = [], None
    for lines in pages_lines:
        for line in lines:
            stripped = line.strip()
            if not stripped:
                continue
            if re.match(r"^(Table 6-|REFERENCE|DESIGNATOR|DESCRIPTION|NO\b|CODE|5700A|"
                        r"Service Manual|List of Replaceable|OR GENERIC|\d+-\d+$|"
                        r"[A-Za-z\-}{|]{1,3}$)", stripped):
                continue

            sm = STOCK_RE.search(stripped)
            if not sm:
                continue
            left = clean_rev9_left(stripped[:sm.start()].rstrip(" |]}"))
            right = stripped[sm.end():]
            fluke = stock_fixes.get(sm.group(1), sm.group(1))

            desig, tail = split_designators_from_description(left)
            desig = clean_designator_tokens(desig)
            if not desig:
                continue
            desc = re.sub(r",\s+", ",", tail).strip(" |,")

            if len(re.sub(r"[^A-Za-z]", "", desc)) >= 3:
                if current:
                    rows.append(current)
                rm = RIGHT_RE.match(right.strip())
                part = clean_mfr_part(rm.group("part")) if rm else None
                current = {
                    "desig_chunks": [desig],
                    "desc": desc,
                    "fluke": fluke,
                    "mfrCode": rm.group("code") if rm else None,
                    "mfrPart": part or None,
                    "qty": int(rm.group("qty")) if rm and rm.group("qty") else None,
                }
            elif current:
                # Continuation: further designators for the row already open.
                current["desig_chunks"].append(desig)
    if current:
        rows.append(current)
    return rows


# --------------------------------------------------------------------------
# supply tables 2-8 / 2-9
# --------------------------------------------------------------------------

SUPPLY_ROW = re.compile(
    r"^\s*(?P<signal>[+\-]?[A-Z0-9][A-Z0-9 /]*?)\s{2,}"
    r"(?P<rest>\S.*?)\s*$"
)


def parse_supply_table(lines, title):
    """
    Return raw cell rows for a supply table. The column meanings differ between
    2-8 (nominal, tolerance, ripple, rated, TP) and 2-9 (nominal, tolerance,
    current limit, rated, TP), and the scanned original has a shifted row, so
    this deliberately returns raw cells for the overrides file to fix up rather
    than guessing.
    """
    out, in_table = [], False
    for line in lines:
        stripped = line.strip()
        if title in stripped:
            in_table = True
            continue
        if not in_table:
            continue
        if stripped.startswith("Table 2-") and title not in stripped:
            break
        if re.match(r"^\d+-\d+\.\s", stripped):     # next numbered section
            break
        if not stripped:
            continue
        if re.match(r"^(Signal Name|Nominal|Output|Tolerance|Max\.|Ripple|Rated|Test|Point|"
                    r"Current|5700A|Service Manual|Theory of Operation|"
                    r"Analog Section|\d+-\d+$)", stripped):
            continue
        cells = [c.strip() for c in re.split(r"\s{2,}", stripped) if c.strip()]
        if len(cells) >= 2:
            out.append(cells)
        if stripped.startswith("*"):
            break
    return out


# --------------------------------------------------------------------------
# section 5-23 procedure
# --------------------------------------------------------------------------

def parse_procedure(lines, title, stop_at=None):
    """
    Collect the numbered steps of a troubleshooting section as raw text.

    `stop_at` ends the section early at a line beginning with that literal. A
    table printed inside a section is furniture the way a figure is, but unlike
    a figure it cannot be recognised by shape: its caption is one line and its
    rows are ordinary prose-width text with lower-case in them, so the filters
    below see nothing to drop and the whole grid lands inside whichever step was
    open. A6 is the case -- §5-5 closes with Table 5-1 and Figure 5-5's caption
    after its last step, and step 14 collected both, which put a table of
    multiplexer logic levels and a reference to U9 into a step that measures a
    sine wave at TP14. The table is carried in data/a6.reference.json instead,
    where it can be read as a table.

    It is deliberately opt-in and per assembly. A10's Table 5-2 sits *between*
    two steps of §5-12 rather than after the last one, so a general rule that
    stopped at a table caption would delete that section's step 4.
    """
    body, in_section = [], False
    for line in lines:
        stripped = line.strip()
        if not in_section:
            if title in stripped:
                in_section = True
            continue
        if stop_at and stripped.startswith(stop_at):
            break
        if re.match(r"^\d+-\d+\.\s+[A-Z]", stripped) and title not in stripped:
            # A wrapped figure cross-reference begins a line with exactly the
            # shape of a section heading. A11 §5-13 step 4 ends "...as shown in
            # Figure" and the next line is "5-18. Next, set the Calibrator to
            # 6.5V dc, operate." -- indistinguishable from "5-14. Duty-cycle
            # Control Circuit" on its own. What tells them apart is the line
            # above: a heading is never preceded by a sentence that has stopped
            # mid-phrase. Without this the section ended at step 4 and twelve
            # steps went missing with nothing to show for it.
            if not (body and re.search(r"\b(Figure|Table|Section|Chapter)\s*\d*-?$",
                                       body[-1])):
                break
        if re.match(r"^(5700A/5720A|Service Manual|Troubleshooting$|"
                    r"Component-level Troubleshooting|\d+-\d+$|Chapter \d)", stripped):
            continue
        # A figure printed inside a section drops its own furniture into the
        # step it interrupts: the artwork filename, the caption, and the bare
        # axis labels off the graticule. A14 step 2 collected "1V 10 ms
        # F5-31.EPS Figure 5-31. Waveform at TP3", and 'F5-31' then read as a
        # reference to a fuse F5. None of the three can be mistaken for a
        # sentence of the procedure -- an axis label is a number and a unit and
        # nothing else, which no step text ever is.
        if re.match(r"^F\d+-\d+\.EPS$", stripped, re.I) or \
           re.match(r"^\d+(\.\d+)?\s*(m|u|µ|k|M)?(V|A|s|Hz|W)$", stripped):
            continue
        if re.match(r"^Figure \d+-\d+\.", stripped):
            # The same trap as the section-heading case above, one rule lower: a
            # wrapped line can *begin* with a figure reference and carry the rest
            # of the sentence with it. A7 §5-8 step 3 is printed "...verify it
            # displays a 2 MHz signal similar to that shown in / Figure 5-13. If
            # a failure is detected, check U14A and U14B." Dropping that line
            # deletes the whole bad-waveform branch -- and the step still reads
            # cleanly afterwards, so nothing downstream can notice. A9 §5-11
            # step 1 loses U6, Q5, Q6 and control line PB7 the same way.
            #
            # What separates the two is the line above, exactly as for headings.
            # A real caption stands alone: the figure's own furniture (the F5-12
            # tag, the axis labels) is filtered above and never reaches body, so
            # body[-1] is the last sentence of the step before the figure, and
            # that sentence has ended. A wrapped reference is preceded by a
            # sentence stopped mid-phrase.
            #
            # One exception, and A11 §5-13 is the reason: there the step text is
            # itself cut mid-reference, ending "...as shown in Figure 5-", and
            # the very next thing on the page is the real caption "Figure 5-20.
            # Waveform at TP7". That prior line has not ended, but the line in
            # hand is still furniture, so treating it as a continuation splices
            # a caption into the middle of a step. A trailing reference stub is
            # the tell, and it is the same shape the heading guard above looks
            # for.
            unfinished = body and not re.search(r"[.:;!?]$", body[-1])
            dangling_ref = body and re.search(
                r"\b(Figure|Table|Section|Chapter)\s*\d*-?$", body[-1])
            if unfinished and not dangling_ref:
                body.append(stripped)
            continue
        # A circuit diagram inside a section leaves its net names and part
        # values behind as well: A16's Figure 5-33 contributed "50K",
        # "OSC OUT HI", "2.2 -22V", "PA OUT HI", "22-220V", "PACOM", "+" and
        # "-", none of which the axis-label rule catches. A short line with no
        # lower-case letter in it is a label off a drawing; every sentence of a
        # step has lower-case in it, and the all-capital headings of the manual
        # are longer than this and already filtered above.
        # Two labels from opposite sides of the drawing share a printed line
        # ("2.2 -22V" and "PA OUT HI" with 60 spaces between them), so the
        # length is measured after collapsing the gaps.
        if len(re.sub(r"\s+", " ", stripped)) <= 30 and not re.search(r"[a-z]", stripped):
            continue
        body.append(stripped)

    steps, current = [], None
    for line in body:
        m = re.match(r"^(\d{1,2})\.\s+(.*)$", line)
        # "...if this voltage is incorrect, proceed with step" wraps, and the
        # number that begins the next line is the end of that cross-reference,
        # not the head of a new step. A16's step 2 ends exactly that way and
        # the number it refers to is 3, which is also the next step's number,
        # so nothing about the number itself can tell the two apart -- the
        # unfinished sentence above it can.
        #
        # The same thing happens to a wrapped figure number: A11 §5-14 step 5
        # ends "...similar to Figure 5-" and the line under it opens "24. If a
        # failure is detected, check U10", which became a step 24 in the middle
        # of a thirteen-step section.
        if m and current and re.search(r"\b(steps?|Figure|Table|Section|Chapter)\s*\d*-?$",
                                       current["text"]):
            m = None
        if m:
            if current:
                steps.append(current)
            current = {"n": int(m.group(1)), "text": m.group(2)}
        elif current and line:
            current["text"] += " " + line
    if current:
        steps.append(current)
    for s in steps:
        s["text"] = re.sub(r"\s+", " ", s["text"]).strip()
        # HR must precede R, or 'HR5' matches nothing at all: the \b before R
        # does not fire between the H and the R, so a hybrid named in a step was
        # simply invisible. A11 §5-13 turns on HR5 and HR6 in four of its
        # sixteen steps, which makes them the most-cited parts on the board.
        # E belongs here for the same reason HR does: without it the one part a
        # step tells you to physically alter is the one part it cannot link to.
        # A5's §5-4 steps 6 and 8 both open "Remove jumper E3 from the J3 pins"
        # and close by telling you to put it back, and A7's §5-7 step 1 and §5-8
        # step 6 tell you to *cut* E1 and E2. A bare 'E3' on a board with no E
        # designators is dropped by the resolve-against-the-BOM pass below, so
        # this adds references only where the part exists.
        s["refs"] = sorted(set(re.findall(
            r"\b(?:HR|TP|CR|VR|Q|U|Z|R|C|E|F|J|K|MP|RT|S|T|L|P)\d+[A-D]?\b", s["text"])))
    return steps


def parse_procedures(lines, titles, stop_at=None):
    """
    One board's troubleshooting, which the manual does not always print as one
    section. A14's runs across 5-19 and 5-20, and 5-19 step 6 refers forward to
    "step 10" -- 5-19 has nine steps, so the magnitude control steps printed as
    1 through 5 were 10 through 14 before the reprint renumbered them and left
    the cross-reference behind. Numbering them back makes that reference land
    where it was written to land, and keeps one board's troubleshooting as one
    sequence, which is how it reads on the bench.

    Each step keeps the section it was printed in, so the citation stays honest
    about where the reader will find it in the manual.
    """
    if isinstance(titles, str):
        titles = [titles]
    steps = []
    for title in titles:
        section = parse_procedure(lines, title, stop_at)
        offset = max((s["n"] for s in steps), default=0)
        for s in section:
            s["n"] += offset
            s["section"] = title.split(".")[0].strip()
        steps.extend(section)
    return steps


# --------------------------------------------------------------------------
# assembly of the extracted record
# --------------------------------------------------------------------------

def build(asm):
    cfg = CONFIG[asm]
    build_dir = os.path.join(ROOT, ".build", asm)
    os.makedirs(build_dir, exist_ok=True)

    text = run_text(SM1996, os.path.join(ROOT, ".build", "text", "sm1996.txt"))

    review = []

    # --- 1996 parts list -------------------------------------------------
    rows96 = parse_parts_1996(text, cfg["parts_table"])
    parts = {}
    fixes96 = PARTS_1996_ROW_FIXES.get(asm, {})
    for row in rows96:
        field = fixes96.get(row["fluke"]) or join_designator_chunks(row["desig_chunks"])
        refs, errors = expand_designators(field)
        if errors:
            review.append("1996 parts: unparsed designator token(s) %s in %r" % (errors, field))
        if row["qty"] and len(refs) != row["qty"]:
            review.append("1996 parts: %s expands to %d designators but Tot Qty is %d"
                          % (field, len(refs), row["qty"]))
        for ref in refs:
            if ref in parts:
                review.append("1996 parts: duplicate designator %s" % ref)
            parts[ref] = {
                "ref": ref,
                "kind": kind_of(ref, asm),
                "desc": row["desc"],
                "fluke": row["fluke"],
                "qty": row["qty"],
                "esd": row["esd"],
                "notes": row["notes"],
                "src": "1996 Series II",
            }

    # --- Rev 9 parts list ------------------------------------------------
    ocr_pages = [run_ocr(CH6, p, build_dir) for p in cfg["rev9_bom_pages"]]
    rows9 = parse_parts_rev9(ocr_pages, asm)
    for row in rows9:
        fix = REV9_MFR_FIXES_BY_STOCK.get(asm, {}).get(row["fluke"])
        if fix:
            row["mfrCode"], row["mfrPart"] = fix

    by_stock = {}
    for p in parts.values():
        by_stock.setdefault(p["fluke"], []).append(p)

    chunk_fixes = OCR_DESIGNATOR_FIXES.get(asm, {})
    stock_fixes = REV9_ROW_FIXES_BY_STOCK.get(asm, {})

    rev9_refs = {}
    for row in rows9:
        # Fixes are applied per printed line: a garbled continuation such as
        # 'CR is' must be corrected before it is joined onto the row above it.
        chunks = [chunk_fixes.get(normalize_designator_field(c), c)
                  for c in row["desig_chunks"]]
        field = stock_fixes.get(row["fluke"]) or join_designator_chunks(chunks)
        refs, errors = expand_designators(field)
        if errors:
            review.append("Rev9 parts: unparsed designator token(s) %s in %r "
                          "(OCR noise -- add to OCR_DESIGNATOR_FIXES if it matters)"
                          % (errors, field))
        for ref in refs:
            rev9_refs[ref] = row

        matched = by_stock.get(row["fluke"])
        if matched:
            # Same stock number in both revisions: the manufacturer columns are
            # simply extra detail for a part that did not change.
            for p in matched:
                p["mfrCode"] = row["mfrCode"]
                p["mfrPart"] = row["mfrPart"]
            # ...but the Rev 9 row may cover designators the 1996 row does not,
            # which means that particular part changed between revisions.
            covered = {p["ref"] for p in matched}
            for ref in refs:
                if ref in covered:
                    continue
                if ref not in parts:
                    # A designator the Rev 9 list names on a row whose stock
                    # number does join. Before A11 this fell through both
                    # branches and the part vanished: Table 6-12 prints
                    # 'K3,K5,K8 ... 3' where Rev 9 prints 'K 3, 5-8 ... 5', so
                    # K6 and K7 -- two relays on the drawing, in the sheet 1
                    # legend and named by §5-15 step 12 -- existed in no list
                    # the dataset could see. The 'no stock match' branch below
                    # has always created these; this one had not.
                    if not rev9_only_is_plausible(ref, parts, asm):
                        review.append("Rev9 parts: %s dropped -- numbered outside this "
                                      "board's %s range, so the scan has run two "
                                      "designators from stock %s together"
                                      % (ref, split_prefix(ref)[0], row["fluke"]))
                        continue
                    parts[ref] = {
                        "ref": ref,
                        "kind": kind_of(ref, asm),
                        "desc": row["desc"],
                        "fluke": row["fluke"],
                        "mfrCode": row["mfrCode"],
                        "mfrPart": row["mfrPart"],
                        "qty": row["qty"],
                        "esd": False,
                        "notes": None,
                        "src": "Rev 9 only",
                        "descOcr": True,
                    }
                    review.append("Rev9 parts: %s is in the Rev 9 list but not the 1996 list "
                                  "-- same row as %s, stock %s, which did join"
                                  % (ref, ",".join(sorted(covered)[:3]), row["fluke"]))
                    continue
                parts[ref]["asBuilt"] = {
                    "desc": row["desc"], "fluke": row["fluke"],
                    "mfrCode": row["mfrCode"], "mfrPart": row["mfrPart"],
                    "src": "Rev 9 (as built)", "descOcr": True,
                }
                review.append("%s: Rev 9 groups it with %s (stock %s) but the 1996 list "
                              "gives it stock %s -- part changed between revisions"
                              % (ref, ",".join(sorted(covered)[:3]), row["fluke"],
                                 parts[ref]["fluke"]))
        else:
            # No stock-number match: either the part changed between revisions,
            # or OCR corrupted the number. Attach by designator and flag it.
            for ref in refs:
                if ref in parts:
                    parts[ref]["asBuilt"] = {
                        "desc": row["desc"],
                        "fluke": row["fluke"],
                        "mfrCode": row["mfrCode"],
                        "mfrPart": row["mfrPart"],
                        "src": "Rev 9 (as built)",
                        "descOcr": True,
                    }
                elif not rev9_only_is_plausible(ref, parts, asm):
                    review.append("Rev9 parts: %s dropped -- numbered outside this board's "
                                  "%s range, so the scan has run two designators together"
                                  % (ref, split_prefix(ref)[0]))
                else:
                    parts[ref] = {
                        "ref": ref,
                        "kind": kind_of(ref, asm),
                        "desc": row["desc"],
                        "fluke": row["fluke"],
                        "mfrCode": row["mfrCode"],
                        "mfrPart": row["mfrPart"],
                        "qty": row["qty"],
                        "esd": False,
                        "notes": None,
                        "src": "Rev 9 only",
                        "descOcr": True,
                    }
                    review.append("Rev9 parts: %s is in the Rev 9 list but not the 1996 list"
                                  % ref)
            if refs:
                review.append("Rev9 parts: stock no %s (%s) did not join on stock number"
                              % (row["fluke"], ",".join(refs[:6])))

    for ref in sorted(parts):
        p = parts[ref]
        if not p.get("mfrPart") and not p.get("asBuilt", {}).get("mfrPart"):
            review.append("no manufacturer part number for %s (%s)" % (ref, p["desc"][:40]))

    # --- supply tables and procedure -------------------------------------
    supplies = {t: parse_supply_table(text, t) for t in cfg["supply_tables"]}
    # Not every assembly has a numbered troubleshooting section -- Chapter 5's
    # component-level procedures cover only some of the boards.
    steps = parse_procedures(text, cfg["procedure"],
                             cfg.get("procedure_stops_at")) if cfg.get("procedure") else []

    # A step's references are pulled out of its prose, so two kinds of token
    # arrive that are not parts of this board and both have to be dealt with
    # here, where the parts list is finally in scope.
    #
    # A section suffix is a correct read, not an error: 'K10A' is one set of
    # K10's contacts and 'K16B' the other, which is what the schematic prints
    # and what §5-22 steps 2, 8 and 9 say. Resolve it to the device rather than
    # dropping a genuine reference -- but only where the device is real, so a
    # part actually named 'K10A' would still stand.
    #
    # A designator from another assembly is not resolvable at all. §5-22's
    # opening jumper instruction names pin 6 of U6 on the Oscillator Control
    # assembly (A12); there is no U6 on A16, and pointing the reader at one
    # would be worse than saying nothing. The step's text still names it, so
    # nothing is lost but the chip.
    #
    # And a test point need not be in either parts list. Six of A11's twelve are
    # wire loops with a stock number; the other six are plated eyelets with no
    # BOM line, and they are the ones §5-13 spends most of its steps on -- TP2
    # is the 13 V reference check in step 2, TP4, TP5, TP6 and TP7 are the four
    # duty-cycle waveforms. Resolving refs against the BOM alone dropped every
    # one of them, so the curated expectations count as well: assemble.py
    # already carries a curated point through whether or not the BOM knows it,
    # and a step that names a point the dataset can show should link to it.
    curated_path = os.path.join(ROOT, "data", "%s.testpoints.json" % asm)
    known = set(parts)
    if os.path.exists(curated_path):
        with open(curated_path, encoding="utf-8") as f:
            curated = json.load(f)
        known |= {t["ref"] for t in curated.get("testpoints", []) if "ref" in t}

    for s in steps:
        resolved = []
        for ref in s["refs"]:
            if ref in known:
                resolved.append(ref)
            elif ref[-1] in "ABCD" and ref[:-1] in known:
                resolved.append(ref[:-1])
        s["refs"] = sorted(set(resolved), key=sort_key)

    out = {
        "id": asm.upper(),
        "name": cfg["name"],
        "pca": cfg["pca"],
        "rev": cfg["rev"],
        "components": [parts[r] for r in sorted(parts, key=sort_key)],
        "supplyTables": supplies,
        "procedureSteps": steps,
    }

    with open(os.path.join(build_dir, "extracted.json"), "w") as f:
        json.dump(out, f, indent=1, sort_keys=False)
    with open(os.path.join(build_dir, "review.txt"), "w") as f:
        f.write("\n".join(review) + "\n")

    print("components:      %d" % len(parts))
    print("supply tables:   %s" % {k.split(".")[0]: len(v) for k, v in supplies.items()})
    print("procedure steps: %d" % len(steps))
    print("review items:    %d  (.build/%s/review.txt)" % (len(review), asm))
    return out


def sort_key(ref):
    m = re.match(r"^([A-Z]+)(\d+)$", ref)
    return (m.group(1), int(m.group(2))) if m else (ref, 0)


if __name__ == "__main__":
    build(sys.argv[1] if len(sys.argv) > 1 else "a18")

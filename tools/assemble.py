#!/usr/bin/env python3
"""
assemble.py — merge the extracted, curated and geometric data into data/<asm>.js.

Three inputs, each owned by a different process, so that re-running any one of
them never destroys the others:

  .build/<asm>/extracted.json   machine-extracted BOM + procedure (build_data.py)
  data/<asm>.testpoints.json    hand-authored test-point expectations
  data/<asm>.coords.json        board and schematic coordinates (Author Mode)

Output is a plain <script src> file rather than JSON so the page works from
file:// with no server.

Usage: tools/assemble.py [assembly-id]
"""

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# Sheet layout of the schematic assets, measured from the extracted images.
# 'frame' is the inner border of the zone grid in normalised sheet coordinates;
# zone labels for a component are derived from it.
SHEETS = {
    # Sheet 1 is the one to open first: it carries the test point legend for all
    # nineteen loops, and eleven of them are on sheet 2.
    "a5": [
        {"id": "sh1", "title": "RMS Sensor, Amplitude Control, Overload and Attenuators",
         "src": "assets/a5/sch1.png", "figure": "7-5 sheet 1 of 3"},
        {"id": "sh2", "title": "Power Amplifier: X10, Unity Gain and 10 Hz-1.1 MHz Buffer",
         "src": "assets/a5/sch2.png", "figure": "7-5 sheet 2 of 3"},
        {"id": "sh3", "title": "Supplies, Digital Control, Relay Drive and Relay States",
         "src": "assets/a5/sch3.png", "figure": "7-5 sheet 3 of 3"},
    ],
    # Six sheets, more than any other assembly. Sheet 1 is the one to open
    # first: it carries the test point legend, the pin maps for both hybrids
    # and both SIPs, and the package legends for every transistor and relay.
    "a11": [
        {"id": "sh1", "title": "Supplies, Hybrid and SIP Pinouts, Heater Control",
         "src": "assets/a11/sch1.png", "figure": "7-11 sheet 1 of 6"},
        {"id": "sh2", "title": "Reference, DC Amplifier, Output Stage and Output Switching",
         "src": "assets/a11/sch2.png", "figure": "7-11 sheet 2 of 6"},
        {"id": "sh3", "title": "Duty-cycle Control Circuitry", "src": "assets/a11/sch3.png",
         "figure": "7-11 sheet 3 of 6"},
        {"id": "sh4", "title": "Buffered Reference SIP and ADC Amplifier",
         "src": "assets/a11/sch4.png", "figure": "7-11 sheet 4 of 6"},
        {"id": "sh5", "title": "ADC Input Selection and ADC Circuit",
         "src": "assets/a11/sch5.png", "figure": "7-11 sheet 5 of 6"},
        {"id": "sh6", "title": "Digital Control and Relay Drive", "src": "assets/a11/sch6.png",
         "figure": "7-11 sheet 6 of 6"},
    ],
    # One sheet, and it carries the whole board: all five supplies, the shut-down
    # circuit, the P41 pinout and the test point legend. Figure 7-24 (A20) starts
    # on the next page, and 5700A-1004 prints no "(n of m)" because there is no n.
    "a19": [
        {"id": "sh1", "title": "Supplies, Shut-down Circuit and P41 Pinout",
         "src": "assets/a19/sch1.png", "figure": "7-23"},
    ],
    # Five sheets, the most of any assembly. Sheet 1 is the one to open first:
    # it carries the test point legend for all thirteen points, the three notes
    # that say which positions are not installed, and the processor itself.
    # One sheet each for the two daughter cards. A16A1's carries the 82C55, the
    # two 5801 relay drivers, the LM339 comparators and the 4051 diagnostic
    # multiplexer -- everything fault codes 3500-3503 exercise.
    "a16a1": [
        {"id": "sh1", "title": "82C55, Relay Drivers, Comparators and Diagnostic Multiplexer",
         "src": "assets/a16a1/sch1.png", "figure": "7-20"},
    ],
    "a13a1": [
        {"id": "sh1", "title": "Discrete Wide-band Amplifier: Input, Mid and Output Driver Stages",
         "src": "assets/a13a1/sch1.png", "figure": "7-16"},
    ],
    # Five sheets. Sheet 1 is the one to open first: it carries the test point
    # legend for all fifteen points, the IC supply-pin table and the connector
    # location table, as well as the IEEE-488 interface.
    "a21": [
        {"id": "sh1", "title": "CPU Interface, IEEE-488 Interface, Clock Regeneration and Supplies",
         "src": "assets/a21/sch1.png", "figure": "7-25"},
        {"id": "sh2", "title": "DUART, RS-232-C Interface and Calibration Switch",
         "src": "assets/a21/sch2.png", "figure": "7-25"},
        {"id": "sh3", "title": "5205A and 5220A Amplifier Interfaces",
         "src": "assets/a21/sch3.png", "figure": "7-25"},
        {"id": "sh4", "title": "Phase Lock In, Variable Phase Out and 5725A Boost Relays",
         "src": "assets/a21/sch4.png", "figure": "7-25"},
        {"id": "sh5", "title": "Guarded Rear Panel I/O, 82C55, Relay Drivers and Relay States",
         "src": "assets/a21/sch5.png", "figure": "7-25"},
    ],
    "a20": [
        {"id": "sh1", "title": "Processor, Clock, Reset, Watchdog and Interrupt Controller",
         "src": "assets/a20/sch1.png", "figure": "7-24 sheet 1 of 5"},
        {"id": "sh2", "title": "EEPROM and EPROM", "src": "assets/a20/sch2.png",
         "figure": "7-24 sheet 2 of 5"},
        {"id": "sh3", "title": "RAM, and the Additional EPROM and RAM Positions",
         "src": "assets/a20/sch3.png", "figure": "7-24 sheet 3 of 5"},
        {"id": "sh4", "title": "Rear Panel and Front Panel Interfaces, Clock Filter",
         "src": "assets/a20/sch4.png", "figure": "7-24 sheet 4 of 5"},
        {"id": "sh5", "title": "DUART, Fan Monitor and Battery-backed Clock/Calendar",
         "src": "assets/a20/sch5.png", "figure": "7-24 sheet 5 of 5"},
    ],
    # Three sheets, counted off the "(n of 3)" title blocks. They split by what
    # passes through rather than by circuit, because nothing on this board is a
    # circuit: sheet 1 is the ac line from the receptacle to the primary taps,
    # sheet 2 is every transformer secondary on its way to the analog side, and
    # sheet 3 is the digital side -- CPU, front panel, rear panel, the digital
    # supply and the two fans. Sheet 3 is the one to open first: it is the only
    # sheet with components on it other than RV1/R4/C6.
    "a4": [
        {"id": "sh1", "title": "AC Input, Line Fuse, Power Switch and Line-Select Switches",
         "src": "assets/a4/sch1.png", "figure": "7-4 sheet 1 of 3"},
        {"id": "sh2",
         "title": "Transformer Assembly Interconnect, Secondary Voltages and P81/P82 "
                  "to the Analog Motherboard",
         "src": "assets/a4/sch2.png", "figure": "7-4 sheet 2 of 3"},
        {"id": "sh3",
         "title": "CPU, Front Panel, Rear Panel and Digital Supply Connectors, "
                  "Fibre-Optic Link and Fan Supplies",
         "src": "assets/a4/sch3.png", "figure": "7-4 sheet 3 of 3"},
    ],
    "a18": [
        {"id": "sh1", "title": "Low-voltage Filter/Regulator", "src": "assets/a18/sch1.png",
         "figure": "7-22 sheet 1 of 2"},
        {"id": "sh2", "title": "Power Amplifier Output Supply", "src": "assets/a18/sch2.png",
         "figure": "7-22 sheet 2 of 2"},
    ],
    "a15": [
        {"id": "sh1", "title": "DC HV Amplifier, Series Pass and Relay Drive",
         "src": "assets/a15/sch1.png", "figure": "7-18 sheet 1 of 2"},
        {"id": "sh2", "title": "2.2 A Amplifier, Supplies and Oven Control",
         "src": "assets/a15/sch2.png", "figure": "7-18 sheet 2 of 2"},
    ],
    "a17": [
        {"id": "sh1", "title": "Voltage Regulators", "src": "assets/a17/sch1.png",
         "figure": "7-21 sheet 1 of 2"},
        {"id": "sh2", "title": "Guarded Digital Control", "src": "assets/a17/sch2.png",
         "figure": "7-21 sheet 2 of 2"},
    ],
    # Sheet 4 carries no circuit -- it is the relay state table for A14 and A15
    # across every range. Extracted and readable, but nothing is placed on it.
    "a16": [
        {"id": "sh1", "title": "Input Stage, Mid Stage and Feedback",
         "src": "assets/a16/sch1.png", "figure": "7-19 sheet 1 of 3"},
        {"id": "sh2", "title": "Output Stage, Sense Current Cancellation and AC Attenuator",
         "src": "assets/a16/sch2.png", "figure": "7-19 sheet 2 of 3"},
        {"id": "sh3", "title": "Relays, Digital Interface and Hybrid Heater Control",
         "src": "assets/a16/sch3.png", "figure": "7-19 sheet 3 of 3"},
    ],
    "a12": [
        {"id": "sh1", "title": "Input Switching, Averaging Converter and Error Integrator",
         "src": "assets/a12/sch1.png", "figure": "7-14 sheet 1 of 3"},
        {"id": "sh2", "title": "Sense Buffers, Thermal Sensors and RCL Switching",
         "src": "assets/a12/sch2.png", "figure": "7-14 sheet 2 of 3"},
        {"id": "sh3", "title": "Digital Control, Relay Drivers and Relay States",
         "src": "assets/a12/sch3.png", "figure": "7-14 sheet 3 of 3"},
    ],
    "a13": [
        {"id": "sh1", "title": "Quadrature Oscillator, Amplitude Control and Phase Shifter",
         "src": "assets/a13/sch1.png", "figure": "7-15 sheet 1 of 3"},
        {"id": "sh2", "title": "Output Amplifier, Gain Control and Phase-Locked Loop",
         "src": "assets/a13/sch2.png", "figure": "7-15 sheet 2 of 3"},
        {"id": "sh3", "title": "Supplies, Diagnostic Circuit and Digital Control",
         "src": "assets/a13/sch3.png", "figure": "7-15 sheet 3 of 3"},
    ],
    "a14": [
        {"id": "sh1", "title": "Transformer, Supplies and Peak Measure",
         "src": "assets/a14/sch1.png", "figure": "7-17 sheet 1 of 4"},
        {"id": "sh2", "title": "Magnitude Control", "src": "assets/a14/sch2.png",
         "figure": "7-17 sheet 2 of 4"},
        {"id": "sh3", "title": "Digital Control", "src": "assets/a14/sch3.png",
         "figure": "7-17 sheet 3 of 4"},
        {"id": "sh4", "title": "Relay States by Range", "src": "assets/a14/sch4.png",
         "figure": "7-17 sheet 4 of 4"},
    ],
    # Five sheets, counted off the "(n of 5)" title blocks. Sheet 1 is the one
    # to open first: it carries the test point legend for all ten points, the
    # 2FCL/4FCL relay bottom-view keys and the transistor package legends.
    # Sheet 5 is the relay state chart and carries no circuit at all -- nothing
    # is placed on it, for the reason A14's sheet 4 gets no reader pass either.
    "a8": [
        {"id": "sh1", "title": "Output Routing, Internal Cal Zero Amplifier and 5725A Interface",
         "src": "assets/a8/sch1.png", "figure": "7-8 sheet 1 of 5"},
        {"id": "sh2", "title": "mV Dividers and LO Output Switching",
         "src": "assets/a8/sch2.png", "figure": "7-8 sheet 2 of 5"},
        {"id": "sh3", "title": "DC 2.2 V Attenuator, Range Amplifier, Hybrid and Supply Entry",
         "src": "assets/a8/sch3.png", "figure": "7-8 sheet 3 of 5"},
        {"id": "sh4", "title": "Digital Control, Relay Drivers, Diagnostics and Relay Supply",
         "src": "assets/a8/sch4.png", "figure": "7-8 sheet 4 of 5"},
        {"id": "sh5", "title": "Relay States by Range", "src": "assets/a8/sch5.png",
         "figure": "7-8 sheet 5 of 5"},
    ],
    # Sheet 1 is the one to open first: it carries the TEST POINT INFORMATION
    # box and the 4FCL/2FCL relay bottom-view keys as well as the ohms bus.
    "a9": [
        {"id": "sh1", "title": "Ohms Bus, 1 Ω / 1.9 Ω / Short, Z5 Divider and Test Point Legend",
         "src": "assets/a9/sch1.png", "figure": "7-9 sheet 1 of 4"},
        {"id": "sh2", "title": "Supplies, 2/5/10 V Source and Differential Amplifier",
         "src": "assets/a9/sch2.png", "figure": "7-9 sheet 2 of 4"},
        {"id": "sh3", "title": "Two-wire Lead Drop Compensation Circuit",
         "src": "assets/a9/sch3.png", "figure": "7-9 sheet 3 of 4"},
        {"id": "sh4", "title": "Digital Control, Relay Drivers and Diagnostic Circuit",
         "src": "assets/a9/sch4.png", "figure": "7-9 sheet 4 of 4"},
    ],
    # Two circuits on one board, and the sheets split cleanly between them:
    # 1 and 2 are the current section, 4 is the hi-res oscillator, 3 is the
    # digital control and the supply entry that both share. Sheet 1 carries the
    # test point legend for TP1-TP10, TP19 and TP20; sheet 4 carries the one
    # for TP11-TP13 and TP16-TP18. Sheet 2 carries the complete relay state
    # chart and the 2FCL/4FCL/2FC bottom-view keys.
    "a7": [
        {"id": "sh1",
         "title": "Current Section: Input Switching, Feedback Buffers, Output Switching "
                  "and Compliance Monitor",
         "src": "assets/a7/sch1.png", "figure": "7-7 sheet 1 of 4"},
        {"id": "sh2",
         "title": "Transconductance Amplifiers, Relay State Chart and Hybrid Heater Control",
         "src": "assets/a7/sch2.png", "figure": "7-7 sheet 2 of 4"},
        {"id": "sh3",
         "title": "Digital Control, Relay Drivers, Diagnostic Circuit and Supply Entry",
         "src": "assets/a7/sch3.png", "figure": "7-7 sheet 3 of 4"},
        {"id": "sh4",
         "title": "Hi-Res Oscillator: Reference Divider, Phase-Locked Loop, VCO and "
                  "Output Switching",
         "src": "assets/a7/sch4.png", "figure": "7-7 sheet 4 of 4"},
    ],
    # Four sheets, but only the first two are circuits: sheets 3 and 4 are the
    # relay state tables for the whole ohms function, which is what 5-12 step 2
    # calls "the relay chart". They are extracted and readable, and nothing is
    # placed on either -- every designator on them is a table column header.
    "a10": [
        {"id": "sh1",
         "title": "Resistance Strings, Relay Contacts, Calibration Buffer and Test Points",
         "src": "assets/a10/sch1.png", "figure": "7-10 sheet 1 of 4"},
        {"id": "sh2",
         "title": "Digital Control, Relay Drivers, Coils and Package Legends",
         "src": "assets/a10/sch2.png", "figure": "7-10 sheet 2 of 4"},
        {"id": "sh3",
         "title": "Relay States by Function (Ohms Main and Ohms Cal)",
         "src": "assets/a10/sch3.png", "figure": "7-10 sheet 3 of 4"},
        {"id": "sh4",
         "title": "Relay States during Calibration (Ohms Main and Ohms Cal)",
         "src": "assets/a10/sch4.png", "figure": "7-10 sheet 4 of 4"},
    ],
    # Three sheets, and sheet 1 is the one to open first: it carries the test
    # point legend for all twelve loops, the whole supply entry and rail
    # generation circuit, and the package legends for every transistor.
    "a6": [
        {"id": "sh1",
         "title": "Supplies, 8 MHz Clock, Phase-locked Loop, Divider and Filter Select",
         "src": "assets/a6/sch1.png", "figure": "7-6 sheet 1 of 3"},
        {"id": "sh2",
         "title": "Amplitude Control Amplifier, X10 Wideband Amplifier and Output",
         "src": "assets/a6/sch2.png", "figure": "7-6 sheet 2 of 3"},
        {"id": "sh3",
         "title": "The Five Octave Filters and the Filter Switch Drive",
         "src": "assets/a6/sch3.png", "figure": "7-6 sheet 3 of 3"},
    ],
}

LAYERS = {
    "a5": [
        {"id": "drawing", "label": "Board drawing", "src": "assets/a5/drawing.png",
         "credit": "Figure 7-5, Chapter 7 Schematic Diagrams (Rev 9)"},
        {"id": "photo", "label": "Board photo", "src": "assets/a5/photo.jpg",
         "credit": "Photograph of an A5, PCA 761346 (etch 5700A-3011 REV F, date stamp 923, "
                   "hand-marked REV 104) — none of the four sheet-metal shields (M2-M5) is "
                   "fitted, so every part on the component side is visible, the K4-K9 "
                   "attenuator included. The pale rectangle at the left is not a lid: it is "
                   "the PTFE RF laminate the attenuator is built on, part of the board, with "
                   "its plated via ring and its own yellow silkscreen — Z1, Z2, K4-K9, "
                   "C25-C37 all readable on it. Registered to the drawing from 32 landmarks "
                   "spread from K7 at the left edge to R55 and R69 at the right, every one of "
                   "them a reviewed board position matched on the photograph by "
                   "cross-correlating the silkscreen around it, and every one on flat artwork "
                   "rather than on the two ejector levers, which are photographed out of the "
                   "position the drawing draws them in. Measured against all 112 reviewed "
                   "positions the match found unambiguously, the alignment is a median 2 px "
                   "out and at worst 7 px, in pixels of this 3400 px image. All 213 markers "
                   "were drawn onto the photograph and checked to land on their own part; the "
                   "two that do not are W1, whose cable is dressed at an angle across the "
                   "straight run the drawing prints, and R54/R61, which sit under the Q7/Q8 "
                   "toroids"},
    ],
    "a11": [
        {"id": "drawing", "label": "Board drawing", "src": "assets/a11/drawing.png",
         "credit": "Figure 7-11, Chapter 7 Schematic Diagrams (Rev 9)"},
        {"id": "photo", "label": "Board photo", "src": "assets/a11/photo.jpg",
         "credit": "Photograph of an A11, PCA 761122 REV P — the adc-amplifier shield (M2) "
                   "and the DAC shield are off, so U25, Z10, U31 and the whole right-hand "
                   "column are visible; both moulded hybrid covers (MP1, MP31) are still "
                   "fitted, so HR5 and HR6 are not"},
    ],
    "a19": [
        {"id": "drawing", "label": "Board drawing", "src": "assets/a19/drawing.png",
         "credit": "Figure 7-23, Chapter 7 Schematic Diagrams (Rev 9)"},
        {"id": "photo", "label": "Board photo", "src": "assets/a19/photo.jpg",
         "credit": "Photograph of an A19, PCA 761056 REV F (etch 5700A-3004 REV E) — nothing "
                   "is shielded, covered or ducted on this assembly, so every part on the "
                   "component side is visible"},
    ],
    # No photograph exists of these three boards, so each has the drawing only.
    "a16a1": [
        {"id": "drawing", "label": "Board drawing", "src": "assets/a16a1/drawing.png",
         "credit": "Figure 7-20, Chapter 7 Schematic Diagrams (Rev 9), drawing 5700A-1671"},
    ],
    "a13a1": [
        {"id": "drawing", "label": "Board drawing", "src": "assets/a13a1/drawing.png",
         "credit": "Figure 7-16, Chapter 7 Schematic Diagrams (Rev 9), drawing 5700A-1652"},
    ],
    "a21": [
        {"id": "drawing", "label": "Board drawing", "src": "assets/a21/drawing.png",
         "credit": "Figure 7-25, Chapter 7 Schematic Diagrams (Rev 9), drawing 5700A-1609"},
    ],
    "a20": [
        {"id": "drawing", "label": "Board drawing", "src": "assets/a20/drawing.png",
         "credit": "Figure 7-24, Chapter 7 Schematic Diagrams (Rev 9), drawing 5700A-1606"},
        {"id": "photo", "label": "Board photo", "src": "assets/a20/photo.jpg",
         "credit": "Photograph of an A20, PCA 761072 REV F (etch 5700A-3006 REV G) — the "
                   "through-hole build, which is what the locator drawing shows too. Nothing "
                   "on this assembly is shielded or covered, so every part on the component "
                   "side is visible, including the four socketed EPROMs at U15-U18 and the "
                   "empty sockets and unpopulated footprints at U23, U24 and U40-U44. "
                   "Registered to the drawing from 26 landmarks spread from C100 at the left "
                   "edge to C145 and TP9 at the right, every one of them a reviewed board "
                   "position matched on the photograph by cross-correlating the silkscreen "
                   "around it, and every one on flat artwork rather than on the two ejector "
                   "levers — which are photographed swung out of their stowed position and "
                   "are therefore neither in the board's plane nor where the drawing draws "
                   "them. Measured against all 79 reviewed positions the match found "
                   "unambiguously, the alignment is a median 5 px out and at worst 13 px, in "
                   "pixels of this 3400 px image; the worst of it is at the right-hand end, "
                   "where the drawing's own scan stretches in a way no single homography can "
                   "take out. All 112 markers were drawn onto the photograph and checked to "
                   "land on their own part"},
    ],
    "a4": [
        {"id": "drawing", "label": "Board drawing", "src": "assets/a4/drawing.png",
         "credit": "Figure 7-4, Chapter 7 Schematic Diagrams (Rev 9), drawing 5700A-1605"},
        {"id": "photo", "label": "Board photo", "src": "assets/a4/photo.jpg",
         "credit": "Photograph of an A4, PCA 760942 REV F (etch 5700A-3005) — nothing on "
                   "this assembly is shielded or covered, but it is photographed with its "
                   "harnesses still fitted: the mains cable into J11 and the fan and "
                   "rear-panel looms lie across the right-hand third of the board and hide "
                   "part of the silkscreen around J11, J14, J15 and J31. The board is "
                   "component side up, in the same orientation as the locator drawing. Note "
                   "the three WARNING HIGH VOLTAGE legends silkscreened on it — beside "
                   "P81/P82, beside J15, and beside J11 — which the drawing does not show. "
                   "Registered to the drawing from the board outline rather than from the "
                   "silkscreen the looms cover: this is a lazy L of dark blue board against "
                   "white paper, so its edge is the clearest thing in either image. The "
                   "outline was extracted from both and 5309 pixels of the drawing's were "
                   "matched to the seven edges the photograph shows unobstructed — the full "
                   "run of the bottom edge, the top edge of the long section, the left and "
                   "right edges, the arm's top edge and both parts of the arm's left edge — "
                   "each required to land on the line of its edge rather than on a point of "
                   "it, since nothing says where along a straight edge a point sits. The "
                   "stretches the looms cross, the bottom-left corner under the line filter "
                   "bracket and the right edge under F1 and SW2-SW4 are excluded, on both "
                   "images. Measured against those 5309 outline pixels the alignment is a "
                   "median 1 px out and at worst 11 px, in pixels of this 3400 px image; "
                   "the worst of it is the arm, which is about 10 px wider here than the "
                   "drawing scales to. All 36 markers were drawn onto the photograph and "
                   "checked to land on their own part"},
    ],
    "a18": [
        {"id": "drawing", "label": "Board drawing", "src": "assets/a18/drawing.png",
         "credit": "Figure 7-22, Chapter 7 Schematic Diagrams (Rev 9)"},
        {"id": "photo", "label": "Board photo", "src": "assets/a18/photo.jpg",
         "credit": "Photograph of an A18, REV H"},
    ],
    "a15": [
        {"id": "drawing", "label": "Board drawing", "src": "assets/a15/drawing.png",
         "credit": "Figure 7-18, Chapter 7 Schematic Diagrams (Rev 9)"},
        {"id": "photo", "label": "Board photo", "src": "assets/a15/photo.jpg",
         "credit": "Photograph of an A15, PCA 761155 REV G — rear shield (MP3) removed, "
                   "but both hybrid covers (MP4, MP5) and the Z5/Z6 heat sinks are fitted"},
    ],
    "a17": [
        {"id": "drawing", "label": "Board drawing", "src": "assets/a17/drawing.png",
         "credit": "Figure 7-21, Chapter 7 Schematic Diagrams (Rev 9)"},
        {"id": "photo", "label": "Board photo", "src": "assets/a17/photo.jpg",
         "credit": "Photograph of an A17, PCA 761171"},
    ],
    "a16": [
        {"id": "drawing", "label": "Board drawing", "src": "assets/a16/drawing.png",
         "credit": "Figure 7-19, Chapter 7 Schematic Diagrams (Rev 9)"},
        {"id": "photo", "label": "Board photo", "src": "assets/a16/photo.jpg",
         "credit": "Photograph of an A16, PCA 761163 — heat sink (MP49) and hybrid "
                   "cover (MP4) fitted, so the output devices and HR8 are not visible"},
    ],
    "a12": [
        {"id": "drawing", "label": "Board drawing", "src": "assets/a12/drawing.png",
         "credit": "Figure 7-14, Chapter 7 Schematic Diagrams (Rev 9)"},
        {"id": "photo", "label": "Board photo", "src": "assets/a12/photo.jpg",
         "credit": "Photograph of an A12, PCA 761130 REV K (artwork 5700A-3050 REV P) — "
                   "the oscillator thermal cover (M12) is fitted over the thermal sensor "
                   "area, so U14 and U16 are not visible"},
    ],
    "a13": [
        {"id": "drawing", "label": "Board drawing", "src": "assets/a13/drawing.png",
         "credit": "Figure 7-15, Chapter 7 Schematic Diagrams (Rev 9)"},
        {"id": "photo", "label": "Board photo", "src": "assets/a13/photo.jpg",
         "credit": "Photograph of an A13, PCA 761148 REV H (etch 5700A-3051 REV N) — "
                   "the oscillator air duct (MP8) and both heat sink retainers are off, "
                   "so U3, U9 and U6 with their TO-8 radial sinks and the A13A1 daughter "
                   "card (U30) are all visible"},
    ],
    "a14": [
        {"id": "drawing", "label": "Board drawing", "src": "assets/a14/drawing.png",
         "credit": "Figure 7-17, Chapter 7 Schematic Diagrams (Rev 9)"},
        {"id": "photo", "label": "Board photo", "src": "assets/a14/photo.jpg",
         "credit": "Photograph of an A14, PCA 775429 — high voltage shield (MP3) fitted, "
                   "so the right-hand 40% of the board is covered"},
    ],
    "a8": [
        {"id": "drawing", "label": "Board drawing", "src": "assets/a8/drawing.png",
         "credit": "Figure 7-8, Chapter 7 Schematic Diagrams (Rev 9)"},
        {"id": "photo", "label": "Board photo", "src": "assets/a8/photo.jpg",
         "credit": "Photograph of an A8, PCA 761106 REV M (etch 5700A-3020 REV M) — the "
                   "moulded cover MP2 is fitted over the 4HR1 hybrid, so H2 and Z1 and the "
                   "silkscreen around them are not visible; the Q3 heater footprint beside "
                   "it is bare, as are the C19 and C24 positions. Everything else on the "
                   "component side is in view"},
    ],
    "a9": [
        {"id": "drawing", "label": "Board drawing", "src": "assets/a9/drawing.png",
         "credit": "Figure 7-9, Chapter 7 Schematic Diagrams (Rev 9)"},
        {"id": "photo", "label": "Board photo", "src": "assets/a9/photo.jpg",
         "credit": "Photograph of an A9, PCA 775395 (the REV field on the silkscreen is "
                   "stamped per board and this one is blank) — both shields are off, so "
                   "every part on the component side is visible, including R41 and R42's "
                   "wirewound bundles at the right-hand edge and the Z5 divider beside them"},
    ],
    "a7": [
        {"id": "drawing", "label": "Board drawing", "src": "assets/a7/drawing.png",
         "credit": "Figure 7-7, Chapter 7 Schematic Diagrams (Rev 9)"},
        {"id": "photo", "label": "Board photo", "src": "assets/a7/photo.jpg",
         "credit": "Photograph of an A7, PCA 764613 (etch 5700A-3021 REV M; the silkscreen "
                   "carries no assembly revision, only 'CURRENT/HI-RES' and the etch "
                   "number) — the four small hi-res shields (MP7–MP10) are off, as §5-8 "
                   "step 1 asks, so the VCO around U19 (an MC1648P) and the reference "
                   "divider around U13, U14 and U16 are readable along with the rest of "
                   "the component side. The moulded hybrid cover (MP6) is still fitted "
                   "over HR2, and that band down the middle of the board is the one part "
                   "this photograph does not show. The photograph is rotated 180° with "
                   "respect to the locator drawing, which the homography takes care of: "
                   "the DIN connectors P211 and P212 overhang the bottom edge here and "
                   "the top edge of the drawing, and the ejector levers are at the top "
                   "here and at the bottom there. Registered to the drawing from 34 "
                   "landmarks spread from TP5 at one corner to TP12 at the far edge, and "
                   "from P212 on the connector edge to TP20 and TP4 on the ejector edge, "
                   "every one of them a reviewed board position matched on the photograph "
                   "by cross-correlating the silkscreen around it. The board outline, "
                   "fitted edge by edge as lines rather than at its corners, is only the "
                   "seed; nothing is landed on the ejector levers or on the three tabs "
                   "along the ejector edge, which stand proud of the board. Measured "
                   "against the 97 of 109 reviewed positions whose match peaked "
                   "unambiguously, the alignment is a median 3 px out and at worst 11 px, "
                   "in pixels of this 3400 px image. All 109 markers were drawn onto the "
                   "photograph and checked to land on their own part; the only region "
                   "carried by the fit rather than measured is the band under MP6, where "
                   "HR2 is the single marker"},
    ],
    "a10": [
        {"id": "drawing", "label": "Board drawing", "src": "assets/a10/drawing.png",
         "credit": "Figure 7-10, Chapter 7 Schematic Diagrams (Rev 9), drawing 5700A-1630"},
        {"id": "photo", "label": "Board photo", "src": "assets/a10/photo.jpg",
         "credit": "Photograph of an A10, PCA 761114 REV 101 (etch 5700A-3030 REV 101) — the "
                   "Ohms Main heat shield (MP7) is off, so all three resistance networks "
                   "(Z1, Z2, Z3), R1 and every relay are visible. Nothing else on this "
                   "assembly is shielded or covered. The photograph is in the same "
                   "orientation as the locator drawing"},
    ],
    "a6": [
        {"id": "drawing", "label": "Board drawing", "src": "assets/a6/drawing.png",
         "credit": "Figure 7-6, Chapter 7 Schematic Diagrams (Rev 9), drawing 5700A-1610"},
        {"id": "photo", "label": "Board photo", "src": "assets/a6/photo.jpg",
         "credit": "Photograph of an A6, PCA 761098 REV H (etch 5700A-3010 REV C) — both "
                   "wideband oscillator shields (MP1 front, MP2 rear) are off, so all five "
                   "filter sections, the phase-locked loop and every part on the component "
                   "side are visible. The photograph is in the same orientation as the "
                   "locator drawing"},
    ],
}

META = {
    "a5": {
        "refs": {
            "locator": "Figure 7-5",
            "parts": "Table 6-6",
            "supplies": [],
            "theory": "§2-222 … §2-228",
            "troubleshooting": "§5-4",
        },
        "warnings": [
            "A5 is fitted only to instruments carrying the -03 wideband option. On a "
            "calibrator without it, slots A5 and A6 are empty and there is no board to "
            "find — which is what fault code 3904, 'Optional Assemblies A5/A6 Are "
            "Missing', reports at power-up.",
            "§5-4 step 1 sets up the whole section: install the board on the 5700A-7001K "
            "extender card (Fluke P/N 857409) with its large right front shield removed "
            "and the rear shield left in place, and connect a 50 Ω load to the type N "
            "WIDEBAND connector on the front panel. Every step after that assumes the "
            "load is there. Running the amplifier without it invalidates every level in "
            "the section, because the 50 Ω source impedance is half of every number.",
            "Every §5-4 measurement is referenced to SCOM (TP16) unless the step says "
            "otherwise, and every output comes from the Wideband option rather than the "
            "main output. COM1 (TP19) is a different common and is used only as the low "
            "side of the external reference §5-4 steps 6 and 8 apply to TP18.",
            "The instrument monitors its own wideband output in software and trips to "
            "standby when it does not like what it sees, which makes step 5 hard to "
            "complete. The Note before that step says to defeat the monitoring by "
            "jumpering TP9 to TP10 — on the DAC assembly (A11), not on this board. A5 "
            "has its own TP9 and TP10 and they are 10Hz-1MHz INPUT and X10 AMP BIAS 1; "
            "jumpering those two would short the buffer input to the x10 amplifier's "
            "bias network.",
            "Steps 6 and 8 both begin by pulling jumper E3 off the J3 pins and driving "
            "TP18 from an external dc supply, and both end with a Note telling you to "
            "remove the supply and put E3 back. Left off, the amplitude control loop "
            "stays open and the board cannot regulate its output at all.",
            "A5 and A6 are a pair: A6 generates the 1.2 MHz to 30 MHz sine wave and A5 "
            "amplifies it, while A5's amplitude control line is what sets A6's level and "
            "A5's WB ON/OFF* line is what enables A6 at all. Fault codes 3910 to 3913 "
            "and 3922 name both assemblies, so a fault on either can present as the "
            "other — and §5-5, A6's own section, opens with a typo calling A6 'the "
            "Wideband Oscillator assembly (A5)'.",
        ],
    },
    "a11": {
        "refs": {
            "locator": "Figure 7-11",
            "parts": "Table 6-12",
            "supplies": [],
            "theory": "§2-100 … §2-117",
            "troubleshooting": "§5-13, §5-14, §5-15, §5-16",
        },
        "warnings": [
            "No high voltage on this board, but it is the most contamination-sensitive "
            "assembly in the instrument. §4-14 says not to touch any circuit area on an "
            "analog assembly and to grasp it by its upper corner ears; here that is not "
            "boilerplate, because the adc works at 20 µV of noise and HR5 is the "
            "instrument's absolute accuracy.",
            "Both hybrids are heated — HR5 to 62 °C, HR6 to 50 °C — and the manual's own "
            "threshold for believing any reference measurement is ten minutes since reset "
            "(fault code 2805). Refit the moulded covers MP1 and MP31 before judging a "
            "heater fault: running uncovered changes the thermal load enough to fail a "
            "good hybrid on fault code 2804.",
            "Three separate commons, and §5-13 alone uses all three. TP3 (REFCOM MECCA "
            "POINT) is the common for most of §5-13 and for §5-14 from step 5 on; TP1 "
            "(SCOM) for §5-14's first four steps, for three §5-15 checks and for both of "
            "§5-16's; TP12 (ADCCOM) for §5-15. §2-115 says outright that the adc's common "
            "is buffered so that reference currents do not return through it, so "
            "substituting one for another gives a plausible but wrong reading.",
            "§5-21 (A15) and §5-22 (A16) both tell you to jumper TP9 to TP10 on this "
            "board to stop the instrument tripping to standby during high-voltage work. "
            "That shorts the adc amplifier's two inputs together and defeats the output "
            "monitor. Both sections say to remove it; sweep for it before closing up.",
            "A11's adc reads the diagnostic line for every other analog assembly, so a "
            "fault here presents as faults everywhere. Confirm A11 before chasing a "
            "calibration or diagnostic code raised against A9, A10, A14, A15 or A16.",
        ],
    },
    "a16a1": {
        "fixed": True,
        "refs": {
            "locator": "Figure 7-20",
            "parts": "Table 6-21",
            "supplies": [],
            "theory": "§2-140",
            "troubleshooting": None,
        },
        "warnings": [
            "This SIP plugs into the bottom of the Power Amplifier (A16) on its two 26-pin "
            "headers P1 and P2, and every signal it handles crosses those headers. Before "
            "suspecting any part on it, check that it is present and seated.",
            "Its designators reuse A16's numbers for different parts: U9, U10, Z1, C57, R2 "
            "and MP3 all exist on both boards. A step or fault code that says 'A16' and names "
            "an 8255, a 5801 or an LM339 means this board.",
            "Fault codes 3500 to 3503, 3521 and 3530 are titled A16 but exercise the 82C55 "
            "(U11) here. Chapter 5 has no section for this board; those codes and §2-140 are "
            "the published procedure.",
            "Every IC on the board is marked static-sensitive in the parts list. Handle it "
            "at a grounded bench.",
        ],
    },
    "a13a1": {
        "fixed": True,
        "refs": {
            "locator": "Figure 7-16",
            "parts": "Table 6-17",
            "supplies": [],
            "theory": "§2-136",
            "troubleshooting": None,
        },
        "warnings": [
            "This is a surface-mount card plugged into the Oscillator Output assembly (A13), "
            "where it is 'U30' on the silkscreen. It runs from A13's +155 V and -125 V rails, "
            "so its P2 pins and the output driver transistors Q7 and Q8 carry the full 22 V "
            "range output swing and the supply that produces it.",
            "R25 is selected at test (1.8 k, 2 k or 2.2 k); do not replace it with a nominal "
            "value without re-checking the dc zero at U2, which R30 adjusts.",
            "There is no Chapter 5 section for this card. §5-18 step 8 on A13 (S1 to the test "
            "position, 1 V across R87, +3.2 V at TP2) is the published way to decide whether "
            "the fault is on this card or in A13's output stage.",
            "All semiconductors on the board are marked static-sensitive in the parts list.",
        ],
    },
    "a21": {
        "fixed": True,
        "refs": {
            "locator": "Figure 7-25",
            "parts": "Table 6-27",
            "supplies": [],
            "theory": "§2-204 … §2-214",
            "troubleshooting": None,
        },
        "warnings": [
            "The board is split into a guarded half (LH, RLH and PA-COM referenced, J8 side) "
            "and an unguarded half (+5 LOGIC COMMON referenced, J1, J2 and J9 side). Do not "
            "connect a meter common between the two, and take each test point against the "
            "common the sheet 1 legend gives for it.",
            "The 5725A boost lines on J7 (B-OUT HI, B-SENSE HI, B-CURRENT) and the cables W1 "
            "to W3 carry the amplifier's full output: up to 1100 V and 11 A. Treat the "
            "relays K1 to K9 and their wiring as live whenever a 5725A is connected and "
            "in operate.",
            "Chapter 5 has no section for this board. Fault codes 3700 to 3705 and 3708 "
            "(the 82C55 U14 and the DUART U5) and §2-204 to §2-214 are the published "
            "procedure.",
            "The fifteen test points are wire loops that appear in the parts list as TP1-15. "
            "Their nets are named only in the sheet 1 legend; their expected values come from "
            "the A19 (Table 2-2) and A17 (Table 2-10) supply tables.",
        ],
    },
    "a20": {
        "refs": {
            "locator": "Figure 7-24",
            # Two numbers because the manual mis-numbers the continuation page:
            # 6-25 is the table and 6-26 is its second half, headed "A20 CPU PCA
            # (cont)". A21's table is 6-27.
            "parts": "Table 6-25 and Table 6-26",
            "supplies": [],
            "theory": "§2-30 … §2-45",
            # Chapter 5 covers neither this board nor any fault code naming it.
            # See the 'faultCodes' caveat in data/a20.reference.json.
            "troubleshooting": None,
        },
        "warnings": [
            "There are no diagnostic fault codes for this assembly. §5-2 was read end to "
            "end and not one of its codes names A20 or the CPU, even as a fallback after "
            "another board reads good — because A20 is the processor that runs the "
            "diagnostics and reports every other assembly's code. A fault here presents as "
            "an instrument that will not boot, or as codes raised against boards that are "
            "in fact healthy. Confirm the +5 V rail at TP6 and the reset lamp CR1 before "
            "believing any code raised against another assembly.",
            "CR1 is the fastest check on the board. §2-31: it indicates that the +5 V "
            "supply is on and that the CPU is out of reset. Lit means running; dark means "
            "either no +5 V or the processor is held in reset by U1 or SW1. U1 resets the "
            "instrument whenever +5 V falls below 4.55 V ±0.05 V, so a supply sagging to "
            "4.5 V produces a dead instrument rather than a marginal one.",
            "SW1 is not the front panel RESET key. §2-31: SW1 is a hardware reset wired "
            "directly to the processor; the front panel RESET is a software reset that "
            "restores the default configuration. Pressing and releasing SW1 produces the "
            "same 195 ms reset pulse as power-up.",
            "The board is drawn and built with positions that are deliberately empty, and "
            "an empty socket here is not a missing part. Sheet 3 prints \"U23, U24, U40 "
            "and U41 are not installed\", sheet 5 prints \"U42, U43, U44 and J5 are not "
            "installed\", and sheet 1 prints \"Y2 is not installed\" and \"remove U42, U43 "
            "and U44 for production units\". §2-37 and §2-38 say the instrument ships with "
            "U15-U18 (512 KB EPROM) and U19-U22 (128 KB RAM) fitted; the other pairs are "
            "expansion, and U42/U43/U44/J5 are a development DUART.",
            "Cutting jumper E1 disables the watchdog timer (§2-33) and jumper E5 selects "
            "the alternate oscillator Y2 as the system clock (§2-32) — but Y2 is not "
            "installed, so moving E5 on a production board stops the clock altogether. "
            "Check both before chasing a processor that will not run.",
            "Replacing BT1 loses the time, the date and the elapsed time counter. §4-21 "
            "has the procedure — the cell is soldered, not in a holder, on this build — "
            "and §4-23 documents the ETIME remote command that sets the counter back. "
            "Read ETIME? before starting, because there is no other copy of it.",
        ],
    },
    "a19": {
        "refs": {
            "locator": "Figure 7-23",
            "parts": "Table 6-24",
            "supplies": ["Table 2-2"],
            "theory": "§2-24 … §2-29",
            # Chapter 5 covers neither this board nor any fault code that names
            # it, so there is nothing to cite. Left absent rather than pointed at
            # something that does not apply -- the first caveat explains why.
            "troubleshooting": None,
        },
        "warnings": [
            "This board runs at line potential behind the fuses and it is not guarded. "
            "The +75 V unregulated rail sits on C1, a 470 µF can at roughly 100 V, and "
            "C12/C13 hold 22 000 µF apiece. R6 and R13 bleed the two high rails, but give "
            "them several seconds after power-down before working near C1, C3 or the "
            "rectifiers.",
            "U2's tab is at the -12 V unregulated INPUT, not at common — the schematic "
            "says TAB TO INPUT. U1's tab is at common and U3's is not; do not assume a "
            "regulator case is safe to lean a probe barrel against.",
            "The +75 V and +35 V supplies are shut down by the circuit in §2-29 when the "
            "front panel stops refreshing the display, so both can read zero with nothing "
            "wrong with either regulator. Check TP3 (PS-SD) and TP6 (RESETL) before "
            "condemning Q1, Q3 or Q5.",
            "A19 powers the CPU that reports every diagnostic fault code, so a fault here "
            "does not raise one — it presents as an instrument that will not boot, or as a "
            "front panel display that is dark or wrong. Nothing in Chapter 5 covers this "
            "board; §2-24 to §2-29 is the published description and the unregulated test "
            "points are the intended method.",
            "The board pulls straight up out of the Digital Motherboard at its top corners, "
            "with its components facing away from the chassis side (§4-15). It and the CPU "
            "(A20) both have to come out to reach the power transformer (§4-16).",
        ],
    },
    "a4": {
        "refs": {
            "locator": "Figure 7-4",
            "parts": "Table 6-5",
            # No supply table names this board. It generates nothing: every rail
            # on it is made on A19, A17 or A18 and merely passes through.
            "supplies": [],
            "theory": "§2-16 … §2-18",
            # Chapter 5 covers neither this board nor any fault code that names
            # it -- §5-2 says every code assumes the motherboards are good --
            # so there is nothing to cite. See the first caveat.
            "troubleshooting": None,
        },
        "warnings": [
            "This is the only assembly in the instrument that carries the ac mains, and it "
            "carries it unguarded and unfused for part of its length. The line arrives at "
            "J31 from the rear-panel filter and runs through SW1 before it reaches F1, so "
            "the power switch and the track between J31 and F1 are live at line potential "
            "whenever the instrument is plugged in, switch off or on. Unplug the line cord "
            "before touching this board — the front-panel power switch does not make it "
            "safe.",
            "Three WARNING HIGH VOLTAGE legends are silkscreened on the board itself, "
            "beside P81/P82, beside J15 and beside J11. They are not about the mains: "
            "P81/P82 and J15 carry the transformer's 428.4 V ac secondary taps to the high "
            "voltage assemblies, and J11 carries the switched line back out to the "
            "transformer primary. The locator drawing does not show these legends; the "
            "photograph does.",
            "Set SW2, SW3 and SW4 for the actual supply before applying power. If they are "
            "set for 115 V on a 230 V line, A18's triac circuit (§2-61) fires deliberately "
            "and shorts the ±17 V secondary to blow this board's F1 — so a blown F1 with no "
            "other damage is evidence of a line-select error, and replacing the fuse "
            "without checking the switches will simply blow the next one. The rear-panel "
            "decal calls these switches S2, S3 and S4; the parts list, the drawing and the "
            "schematic call them SW2, SW3 and SW4.",
            "The manuals give three different answers for F1. Table 6-5 and Rev 9 both say "
            "3 A, 250 V, slow (stock 109280, Bussmann MDL-3) for 100–120 V with a different "
            "part, 109231, for 200–230 V; schematic sheet 1 annotates it 3.0A SLO; and the "
            "rear-panel decal drawn in Figure 3-1 reads T 125A 250V (SB) for both voltage "
            "ranges. The manual's own safety page says to use only the fuse specified on "
            "the line voltage selection switch label, so read the label on the instrument "
            "in front of you rather than any of these. See the caveat.",
            "A4 is the last assembly out and the first in. §4-16 has the front and rear "
            "panels off, A19 and A20 out, the rear fan out and all five transformer "
            "connectors detached before the Digital Motherboard itself comes out from the "
            "bottom of the instrument — and the Analog Motherboard (A3) is screwed to it, "
            "mated through P81/P82 into J81/J82 (§2-16).",
            "Nothing on this board reports a fault. §5-2 states outright that every "
            "diagnostic fault code assumes the motherboard assemblies are fully "
            "operational, and A4 carries the CPU, the front panel and the fibre-optic link "
            "that a code would have to travel over. So an A4 fault presents as an "
            "instrument that is dead, that will not boot, or that has lost one whole "
            "assembly — not as a number on the display.",
        ],
    },
    "a18": {
        "refs": {
            "locator": "Figure 7-22",
            "parts": "Table 6-23",
            "supplies": ["Table 2-8", "Table 2-9"],
            "theory": "§2-57 … §2-66",
            "troubleshooting": "§5-23",
        },
        "warnings": [
            "The ±PA supplies reach ±500 V. Power the instrument down before operating "
            "the S201 voltage switch or moving any jumper.",
            "§5-23 assumes the assembly is on an extender card with the Power Amplifier "
            "assembly (A16) removed, and every measurement referenced to PACOM (TP203).",
        ],
    },
    "a15": {
        "refs": {
            "locator": "Figure 7-18",
            "parts": "Table 6-19",
            "supplies": [],
            "theory": "§2-155 … §2-166",
            "troubleshooting": "§5-21",
        },
        "warnings": [
            "High voltages are exposed when troubleshooting this assembly — the manual "
            "prints that warning at the head of §5-21. The rear shield (MP3) has to come "
            "off and the board then runs on the extender card carrying the 1100 V output "
            "node, HV OUT and HV SENSE, and three high-voltage cable assemblies (W1–W3).",
            "Every §5-21 measurement is referenced to ACOM (TP7) unless the step says "
            "otherwise. The VI± pair at TP9 and TP10 is the exception: those return to "
            "VI COM at P602 pins 17A/17C, not to ACOM.",
            "In the 1100 V ac range the instrument's own software monitors the output and "
            "trips to standby, which fights you during step 8. The published workaround is "
            "a jumper from TP9 to TP10 on the DAC assembly (A11) — not on this board, "
            "which has test points of the same names — and the manual is explicit about "
            "removing it before step 9.",
            "Steps 12–14 need the front panel OUTPUT HI binding post jumpered to OUTPUT "
            "LO, and step 12 needs R37 unsoldered at one end. Resolder R37 and refit the "
            "H4 hybrid cover before continuing, or the oven regulation checks (3104, 3105) "
            "will read wrong.",
            "A15 and A14 are a matched pair: every relay and control line on A15 is driven "
            "from A14, and A15's series-pass circuit closes A14's magnitude loop. A15 has "
            "no digital section of its own, so a fault on either board can present as the "
            "other.",
        ],
    },
    "a17": {
        "refs": {
            "locator": "Figure 7-21",
            "parts": "Table 6-22",
            "supplies": ["Table 2-10"],
            "theory": "§2-70 … §2-79",
            "troubleshooting": "§5-2 fault codes 3600–3615",
        },
        "warnings": [
            "The board carries no high voltage, but it feeds every analog assembly: a "
            "short applied while probing takes the whole instrument down.",
            "FR1 COM (TP1) and FR2 COM (TP6) float with respect to S COM and LH COM. "
            "Move the meter's low lead to the rail's own return before each reading "
            "rather than leaving it on one common.",
            "The guarded digital section sits at guard potential. Reference TP55 or "
            "TP58, not chassis.",
        ],
    },
    "a8": {
        "refs": {
            "locator": "Figure 7-8",
            "parts": "Table 6-9",
            "supplies": [],
            "theory": "§2-87 … §2-99",
            "troubleshooting": "§5-9",
        },
        "warnings": [
            "Every relay on this board is a latching type and holds its position with "
            "the power off. §5-9 step 1 turns that into the primary troubleshooting "
            "method — set the failing function, power down, pull the board and ohm the "
            "signal path cold against the relay chart on schematic sheet 5 — but it "
            "cuts the other way too: a board pulled after a fault comes out still "
            "configured for whatever range it failed in, which in the 220 V or 1100 V "
            "ranges means the high-voltage path is connected. Establish the state "
            "before assuming anything on it is safe.",
            "Exercise an individual relay by putting an external supply across its set "
            "or reset coil; §5-9 suggests a 9 V battery. The coils are 5 V parts driven "
            "with 10 ms latching pulses, not continuously, so touch and remove rather "
            "than leaving the battery connected.",
            "There is no single common. §5-9 uses three in six steps: TP9 (S COM) for "
            "the RLY+V check in step 2, TP8 (R COM) for the range checks in steps 4 and "
            "5, and the front panel OUTPUT LO binding post — not a board point at all — "
            "for the millivolt divider check in step 6. Carrying one step's common into "
            "the next gives a plausible and wrong reading.",
            "Steps 4 and 5 print a ±6 mV band and then a Note allowing ±0.12 V if the "
            "DAC assembly is uncalibrated. That is twenty times wider. On an instrument "
            "part-way through a repair the tight number is unusable; judge against "
            "±0.12 V or you will chase a fault that is not there.",
            "A8's multiplexer is the measuring path for the guarded supply rails of the "
            "whole analog section, so a fault in U4 or in the ÷11 dividers (Z5, Z6) "
            "presents as several supply fault codes at once — 3600, 3601, 3607, 3608, "
            "3609 — with every supply measuring perfectly on A17 and A18. If you see "
            "that pattern, suspect this board's diagnostic circuit before measuring the "
            "supplies a third time.",
            "The 4HR1 hybrid is held at 50 °C under the moulded cover MP2. Refit the "
            "cover before judging fault code 3824 or any millivolt reading, and give it "
            "time to warm up: running it uncovered changes the thermal load enough to "
            "fail a good assembly.",
        ],
    },
    "a16": {
        "refs": {
            "locator": "Figure 7-19",
            "parts": "Table 6-20",
            "supplies": [],
            "theory": "§2-139 … §2-154",
            "troubleshooting": "§5-22",
        },
        "warnings": [
            "The ±PA supplies reach ±365 V and the output reaches 220 V rms. The rear "
            "high voltage shield (MP50) and the front air duct (MP58) both come off "
            "before troubleshooting, and the board then runs live on the extender card.",
            "§5-22 begins by defeating the software output monitor with two jumpers — "
            "A11 TP9 to TP10, and A13 TP1 to the bottom of R8 on A12 — and step 12 adds "
            "a third from U5 pin 1 to TP11. Sweep for all of them before closing up: "
            "the instrument is running with a protection layer removed until they go.",
            "Step 3 switches A18's ±PA supplies to the ±44 SR test rails with S201. "
            "Power the instrument down before moving that switch, and put it back — "
            "left in the test position it produces fault 3507 at every power-up.",
            "The air duct is part of the cooling design and MP49 is the only heat sink "
            "the output devices have. Do not leave the board running on the extender "
            "with the duct off for longer than a measurement takes; fault 3524 fires "
            "when the temperature sensor passes 1.7 V.",
        ],
    },
    "a12": {
        "refs": {
            "locator": "Figure 7-14",
            "parts": "Table 6-15",
            "supplies": [],
            "theory": "§2-119 … §2-129",
            "troubleshooting": "§5-17",
        },
        "warnings": [
            "§5-17 begins by defeating the instrument's own output monitor with two "
            "jumpers: TP9 to TP10 on the DAC assembly (A11), and SDL (P501 pin 11A/11C) "
            "to SCOM (P502 pin 32A/32C) on this board. Without them the software trips "
            "the instrument to standby while you are probing. The manual says explicitly "
            "to remove both before step 9, and until they go the instrument is running "
            "with its output monitoring switched off.",
            "The board runs live on the extender card with the rear shield removed. It "
            "carries no high voltage of its own, but it is an analog assembly and §4-14 "
            "warns against touching any circuit area: skin oil leaves resistive paths, "
            "and on a board whose whole job is a few-ppm ac/dc comparison that is a real "
            "error source, not a housekeeping note. Grasp it by the upper corner ears.",
            "Every §5-17 measurement is referenced to TP2 (OSC SENSE LO) unless the step "
            "says otherwise. OSC COM is a separate common, brought in on P501 pins "
            "3A/3C with the ±15 OSC supplies.",
            "U14 and U16 are thermal RMS sensors and each has a protection circuit that "
            "shuts its signal path down if the junction passes 200 °C — U21A and the FETs "
            "for U14 (§2-127), U22D and Q14 for U16 (§2-129). A board reading low or zero "
            "at TP7 may be protecting itself rather than failing.",
            "A12 and A13 are a pair: A13 generates the ac signal and A12 controls its "
            "amplitude through the OSC CONT line, while A13 generates two of A12's own "
            "control lines (LFCOMP*, HFCOMP*). Fault codes 3410–3416 and 3425 name both "
            "assemblies, so a fault on either can present as the other.",
        ],
    },
    "a13": {
        "refs": {
            "locator": "Figure 7-15",
            "parts": "Table 6-16",
            "supplies": [],
            "theory": "§2-130 … §2-138",
            "troubleshooting": "§5-18",
        },
        "warnings": [
            "§5-18 opens by defeating the software output monitor with two jumpers — "
            "A11 TP9 to TP10, and SDL (P511 pin 11A/11C) to SCOM (TP1) on this board. "
            "The second one grounds the diagnostic multiplexer's output, so while it is "
            "fitted every 34xx fault code reads meaningless. Sweep for both before "
            "closing up: the instrument runs with its output monitoring removed until "
            "they go.",
            "The front air duct (MP8) and the rear shield both come off and the board "
            "then runs live on the extender card. The duct is part of the cooling "
            "design for the output stage — Q10, Q11, Q16 and Q17 with their case clips "
            "(HS4–HS7) and the three TO-8 radial sinks (HS1–HS3) on U3, U9 and U6 are "
            "the only heat sinking those parts have.",
            "S1 pulls the input of the A13A1 output stage low for the step 8 resistor "
            "check. Return it to the operate position (to the right) before continuing "
            "— step 8d says so explicitly, and left in test the 2.2 V and 22 V ranges "
            "produce no output at all.",
            "A12 and A13 are a matched pair: A12 measures A13's output and sends back "
            "OSC CONT to set its amplitude, so an amplitude fault can sit on either "
            "board. The 3410–3416 fault codes are titled 'A12/A13' for exactly that "
            "reason and their verdicts are split between the two.",
        ],
    },
    "a14": {
        "refs": {
            "locator": "Figure 7-17",
            "parts": "Table 6-18",
            "supplies": [],
            "theory": "§2-155 … §2-167",
            "troubleshooting": "§5-19, §5-20",
        },
        "warnings": [
            "High voltages are exposed when troubleshooting this assembly. The rear "
            "shield (MP3) has to come off and the board runs on the extender card with "
            "the 1100 V range output, ±HVDC across C1 and the T1 secondary all live.",
            "C1 holds about 0.44 J charged to 1100 V and bleeds through the 600 kΩ of "
            "R3–R5, a time constant of roughly 0.4 s. It does discharge — confirm it "
            "has before working near it.",
            "Steps 8, 9 and 13 need the front panel OUTPUT HI binding post jumpered to "
            "OUTPUT LO. Both sections say explicitly to remove it before continuing.",
            "A14 and A15 are a matched pair: A14's digital section drives A15's relays "
            "and A14's magnitude loop closes through A15's series-pass circuit, so a "
            "fault on either can present as the other. Step 4 exists to hand off to A15.",
        ],
    },
    "a9": {
        "refs": {
            "locator": "Figure 7-9",
            "parts": "Table 6-10",
            "supplies": [],
            "theory": "§2-173 … §2-185",
            "troubleshooting": "§5-10, §5-11",
        },
        "warnings": [
            "A9 mounts component side to the REAR — one of only three analog assemblies "
            "that do, with A7 and A14 — so it needs the analog reverse extender card, "
            "not the plain one. §5-10 step 1 also has you remove the rear shield before "
            "putting the board up.",
            "Every one of the 31 relays is latching, and they hold their state with the "
            "power off. A board pulled after a fault comes out in the failing "
            "configuration; establish what that configuration is before assuming "
            "anything. §5-10 step 1 turns this into the board's main technique — set the "
            "failing function, switch off, and trace the path cold — and checks "
            "individual relays with an external supply (a 9 V battery) across the set or "
            "reset coil. Those are 5 V coils meant for millisecond pulses; pulse briefly.",
            "Three different commons, and they are not interchangeable. TP7 (ACOM) is "
            "the floating common of the two-wire compensation supply and §5-11 step 1 is "
            "referenced to it alone; TP12 (SCOM) and TP10 (RCOM/SCOM) serve the source "
            "and the differential amplifier; and the relay drivers run on +5 RLH to RLH "
            "COM with the logic on +5 LH to LH COM, neither of which has a test point at "
            "all. A meter left on TP12 reads the floating supply wrong.",
            "A9's 82C55 (U11) controls the relay drivers on the Ohms Main assembly (A10) "
            "as well as its own, so a dead digital section here presents as an ohms fault "
            "spanning both boards with no A10-specific code. Fault 3338 (assembly not "
            "responding) is the give-away.",
            "Every diagnostic in the 3311–3341 range is read through A9's differential "
            "amplifier and driven by A9's 2/5/10 V source, so a fault in either lights up "
            "most of the block at once. Clear 3304–3310 before reading anything into an "
            "individual ratio or check code.",
            "§4-14 applies in its strong form here: do not touch any circuit area, and "
            "grasp the assembly by its upper corner ears. Z5 is the instrument's internal "
            "resistance standard and R41/R42 are 0.04 % wirewound sets — skin oil across "
            "them is a leakage path, not a smudge.",
        ],
    },
    "a7": {
        "refs": {
            "locator": "Figure 7-7",
            "parts": "Table 6-8",
            "supplies": [],
            "theory": "§2-186 … §2-203",
            "troubleshooting": "§5-6, §5-7, §5-8",
        },
        "warnings": [
            "Two jumpers get CUT, not unplugged. §5-7 step 1 cuts E1 to break the current "
            "feedback loop; §5-8 step 6 cuts E2 to break the phase-locked loop. Both are "
            "wire links, stock 816090 — the same part as the test points — and the manual "
            "tells you to replace or reconnect each one (the note between §5-7 steps 10 "
            "and 11, and the last sentence of §5-8 step 8). A board left with E1 cut has "
            "an open current loop; left with E2 cut it has an unlocked hi-res oscillator, "
            "which breaks every ac function on the instrument.",
            "Two commons that are not interchangeable. Every §5-7 measurement is "
            "referenced to SCOM (TP20) unless the step says otherwise, and every §5-8 "
            "measurement to LHCOM (TP18). Step 11 of §5-7 is the one documented exception: "
            "it references TP2. TP17 is a second SCOM loop sitting inside the hi-res "
            "section and is the easy mistake to make in §5-8.",
            "This board is a current source and §5-7 runs it hard. Step 2 jumpers the "
            "OUTPUT HI binding post to OUTPUT LO and leaves it there for eleven steps at "
            "up to 200 mA, and step 14 deliberately provokes an over-compliance trip to "
            "standby. Treat the binding posts as live throughout, and take the jumper out "
            "when you have finished.",
            "The analog REVERSE extender card is specified, not the plain one — §5-7 step "
            "2 and §5-8 step 1 both say so. A7 is one of only three analog assemblies "
            "whose component side faces the rear of the instrument (§4-14).",
            "K14, K15 and K17 do not latch. They drop out with the power off, and K14 and "
            "K15 are exactly the relays that connect the output, so A7's output path "
            "cannot be traced cold the way A8's and A9's can — a continuity check on a "
            "board out of the instrument reads open whether or not anything is wrong.",
            "A7's hi-res output is what the Oscillator Output assembly (A13) phase-locks "
            "to, on P LOCK HI. A fault in the hi-res half therefore presents as an ac "
            "frequency fault everywhere downstream of A13 rather than as a current fault "
            "here. §5-8 step 2 failing with U13 good points back at A17, which generates "
            "the 8 MHz CLK/CLK* pair the divider chain starts from.",
        ],
    },
    "a10": {
        "refs": {
            "locator": "Figure 7-10",
            "parts": "Table 6-11",
            "supplies": [],
            "theory": "§2-168 … §2-172",
            "troubleshooting": "§5-12",
        },
        "warnings": [
            "This board IS the instrument's ohms accuracy. Z1, Z2, Z3 and R1 are "
            "hermetically sealed, individually characterised thin-film parts, and §4-14's "
            "'do not touch any circuit area on an analog assembly, grasp it by its upper "
            "corner ears' is not boilerplate here — a fingerprint's worth of skin oil "
            "across a 100 MΩ node is a measurable leakage path. Do not apply heat near "
            "the networks, do not flux-clean around their pins, and refit the heat shield "
            "(MP7) before judging any measurement.",
            "Five relays do not latch, and they are exactly the ones you would want to "
            "trace cold. K5 (100 MΩ), K8 (10 MΩ), K11 and K12 (19 MΩ) and K6 (two-wire "
            "compensation) are reed relays driven by U3, and they drop out when the power "
            "is removed — so the technique §5-12 step 2's note describes, setting the "
            "failing function and then switching off so the latching relays hold their "
            "state, does not work for the 10 MΩ, 19 MΩ or 100 MΩ values. Those three have "
            "to be traced with the calibrator powered and in the right function. K38 is "
            "also non-latching.",
            "Every other relay does latch, which cuts the other way: a board pulled after "
            "a fault comes out still configured for the function that failed, and "
            "reinstalling it does not reset it. §5-12 step 2 suggests driving an "
            "individual coil from a 9 V battery — set coil for set, reset coil for reset. "
            "Sheet 2's bottom-view legends say which pins those are: 2FC for K38, 2FCL for "
            "K1–K4, K7, K9, K10, K13–K17, K28–K30 and K33–K37, 4FCL for K18–K27, K31, K32 "
            "and K39.",
            "A10 has no processor and no diagnostic multiplexer. Every relay on it is "
            "driven from the 82C55 on the Ohms Cal assembly (A9) across the motherboard, "
            "and every self-test reading of it is taken by the adc on the DAC assembly "
            "(A11) through A9's differential amplifier. So an ohms function that is dead "
            "rather than merely inaccurate is an A9 fault until proved otherwise — fault "
            "3338, 'Assembly A9 Not Responding', covers both boards — and any 33xx code "
            "should be read only after 3337 (the A11 reference check) is clear.",
            "Three commons, and only one of them is on the board. TP1 is SCOM, the "
            "reference for ±17 S and for U1. The relay drivers sit on RLH COM and the "
            "logic on LH COM, and neither is brought out to a test point anywhere on this "
            "assembly — a meter clipped to TP1 reads both of them wrong. §5-12 itself "
            "never uses a common at all: all four of its connections are ohmmeter leads.",
            "§5-12 gives a bench tolerance only up to 1.9 kΩ (Table 5-2) and then jumps "
            "straight to 100 MΩ. Nothing between 10 kΩ and 19 MΩ has a published "
            "resistance tolerance. For those decades the published expectations are the "
            "ratio and check fault codes 3313 to 3332, which measure through A9 and A11 "
            "rather than at these test points.",
        ],
    },
    "a6": {
        "refs": {
            "locator": "Figure 7-6",
            "parts": "Table 6-7",
            "supplies": [],
            "theory": "§2-215 … §2-221",
            "troubleshooting": "§5-5",
        },
        "warnings": [
            "This assembly is fitted only to instruments with the -03 Wideband AC Voltage "
            "option. On a calibrator without it there is no A6 and no A5, the two slots in "
            "front of A7 are empty and the front panel has no Type N WIDEBAND connector — "
            "nothing has been removed. The front panel is the quickest way to tell.",
            "§5-5 steps 6, 7, 8 and 9 all begin by pulling shorting header E6 off the J6 "
            "pins so that TP2 can be driven from an external 2 to 13 V dc reference. That "
            "breaks the phase-locked loop: with E6 off, nothing on this board reads "
            "correctly and the instrument's own wideband output is meaningless. The note "
            "printed after step 9 says to power down, remove the external reference and "
            "refit E6 — sweep for it before closing up, exactly as for A11's TP9–TP10 "
            "jumper.",
            "§5-5 step 1 has both shields off (MP1 front, MP2 rear) and the board up on an "
            "extender card. That is how the section is meant to be run, but the shields "
            "are part of the screening at 30 MHz and the extender adds its own length to "
            "every net: refit MP1 and MP2 and put the board back in its slot before "
            "judging a marginal output or a distortion complaint at the top of the band.",
            "There is no fuse and no regulator anywhere on this board — Table 6-7 has no F "
            "designator at all. All four rails (+5 LH, −5 LH, +17 S, −17 S) are regulated "
            "and protected on the Regulator/Guard Crossing assembly (A17), upstream of "
            "P101, so a short here is limited by A17 and presents as an A17 or a "
            "whole-instrument symptom rather than as anything local.",
            "Only two of the instrument's fault codes name this board outright, 3905 and "
            "3906, and both of them measure it indirectly: the vco's input voltage is "
            "divided into WB PLL DIAGNOSTICS, sent to A5, put on the SDL line and read by "
            "the adc on the DAC assembly (A11). A fault anywhere on that path raises a "
            "phase lock loop complaint against a healthy A6, so clear 3922 and A11's own "
            "codes first. Everything else in the 39xx series that mentions A6 is measured "
            "on A5 and blamed on A5.",
            "Most of this board runs at ECL levels between 0 V and −5 V, not at TTL levels "
            "— U3 to U6 are MC1648, MC10131, MC10154 and MC10164. A logic probe expecting "
            "0 V and +5 V reads every one of them as low. §5-5 uses a frequency counter "
            "and an oscilloscope for that reason, and Table 5-1's own levels for U6's "
            "select pins are −5 V and 0 V.",
        ],
    },
}

# Which published procedure the dataset presents. Not every assembly has a
# numbered Chapter 5 section -- A17's published troubleshooting is the
# 3600-series fault codes -- so this is allowed to be absent.
PROCEDURES = {
    "a5": {
        "id": "5-4",
        "title": "Troubleshooting the Wideband Output Assembly (A5)",
        "source": "§5-4, 5700A/5720A Series II Service Manual, pages 5-40 to 5-42. "
                  "Printed as one section of nine steps; the numbering here is the "
                  "manual's own. Step 1 is the setup rather than a measurement. The "
                  "section cites none of Figures 5-1 to 5-5 — all five belong to §5-5, "
                  "the Wideband Oscillator (A6) section that follows it.",
    },
    "a11": {
        "id": "5-13",
        "title": "Troubleshooting the DAC Assembly (A11)",
        "source": "§5-13 to §5-16, 5700A/5720A Series II Service Manual, pages 5-58 to "
                  "5-68. Printed as four sections each numbered from 1: §5-13 (16 steps), "
                  "§5-14 Duty-cycle Control Circuit (13), §5-15 ADC Circuit (14) and "
                  "§5-16 Buffered Reference SIP Assembly A11A2 (2). Walked here as one "
                  "sequence, so steps 17–29 are §5-14's 1–13, steps 30–43 are §5-15's "
                  "1–14 and steps 44–45 are §5-16's 1–2. Each step names its own section. "
                  "The manual gives no numeric cross-reference between them — §5-13 hands "
                  "off by name, 'skip to Duty Cycle Control Circuit' — so the renumbering "
                  "is this dataset's, not the manual's; see the procedure caveat.",
    },
    "a18": {
        "id": "5-23",
        "title": "Troubleshooting the Filter/PA Supply Assembly (A18)",
        "source": "§5-23, 5700A/5720A Series II Service Manual",
    },
    "a15": {
        "id": "5-21",
        "title": "Troubleshooting the High Voltage/High Current Assembly (A15)",
        "source": "§5-21, 5700A/5720A Series II Service Manual, pages 5-77 to 5-79. "
                  "Printed as one section of fourteen steps; the numbering here is the "
                  "manual's own.",
    },
    "a16": {
        "id": "5-22",
        "title": "Troubleshooting the Power Amplifier Assembly (A16)",
        "source": "§5-22, 5700A/5720A Series II Service Manual",
    },
    "a12": {
        "id": "5-17",
        "title": "Troubleshooting the Oscillator Control Assembly (A12)",
        "source": "§5-17, 5700A/5720A Series II Service Manual, pages 5-69 to 5-72. "
                  "Printed as one section of ten steps; the numbering here is the "
                  "manual's own. Steps 1–7 check the averaging converter, steps 8–10 "
                  "the ac/dc transfer circuit.",
    },
    "a13": {
        "id": "5-18",
        "title": "Troubleshooting the Oscillator Output Assembly (A13)",
        "source": "§5-18, 5700A/5720A Series II Service Manual, pages 5-72 to 5-74. "
                  "One section of twelve steps; the numbering here is the manual's own.",
    },
    "a14": {
        "id": "5-19",
        "title": "Troubleshooting the High Voltage Control Assembly (A14)",
        "source": "§5-19 and §5-20, 5700A/5720A Series II Service Manual. Steps 10–14 "
                  "are printed as §5-20 steps 1–5; they are numbered here as §5-19 "
                  "step 6's own cross-reference assumes.",
    },
    "a9": {
        "id": "5-10",
        "title": "Troubleshooting the Ohms Cal Assembly (A9)",
        "source": "§5-10 and §5-11, 5700A/5720A Series II Service Manual, pages 5-56 to "
                  "5-57. Printed as two sections each numbered from 1: §5-10 (two steps, "
                  "the first of which is the setup paragraph shown above) and §5-11 "
                  "Two-wire Compensation Circuit (two steps). Walked here as one "
                  "sequence, so step 2 is §5-10's step 2 and steps 3 and 4 are §5-11's "
                  "steps 1 and 2. Each step names its own section. Unlike A14 the manual "
                  "gives no cross-reference that requires the merge — §5-11 step 1's "
                  "'skip to step 2' resolves inside §5-11, which is step 4 here — so the "
                  "renumbering is this dataset's, not the manual's; see the procedure "
                  "caveat.",
    },
    "a8": {
        "id": "5-9",
        "title": "Troubleshooting the Switch Matrix Assembly (A8)",
        "source": "§5-9, 5700A/5720A Series II Service Manual, pages 5-54 to 5-56. One "
                  "section of six steps and no sub-sections; the numbering here is the "
                  "manual's own. Step 1 is the prerequisite paragraph — the cold "
                  "ohmmeter method against the relay chart on schematic sheet 5 — and "
                  "the five numbered steps that follow are bench measurements. Note that "
                  "the section's own page carries Figure 5-15, which belongs to §5-8 and "
                  "shows a waveform at A7's TP16, not anything on this board.",
    },
    "a7": {
        "id": "5-6",
        "title": "Troubleshooting the Current/Hi-Res Assembly (A7)",
        "source": "§5-6, §5-7 and §5-8, 5700A/5720A Series II Service Manual, pages 5-47 "
                  "to 5-54. §5-6 itself carries no numbered steps at all — it is four "
                  "lines saying the two circuits are independent and are troubleshot "
                  "separately. The steps come from its two sub-sections, each printed "
                  "numbered from 1: §5-7 Current Section (14 steps, the first of which is "
                  "the setup paragraph shown above) and §5-8 Hi-Res Oscillator Section "
                  "(10 steps). Walked here as one sequence, so steps 2–14 are §5-7's own "
                  "2–14 and steps 15–24 are §5-8's 1–10. Each step names its own section. "
                  "The renumbering is this dataset's and not the manual's, and §5-8 step "
                  "4's printed 'skip to step 9' means §5-8's step 9, which is step 23 "
                  "here — see the procedure caveat.",
    },
    "a10": {
        "id": "5-12",
        "title": "Troubleshooting the Ohms Main Assembly (A10)",
        "source": "§5-12, 5700A/5720A Series II Service Manual, pages 5-57 to 5-58. One "
                  "section of four steps and no sub-sections; the numbering here is the "
                  "manual's own. Step 1 is the prerequisite paragraph. Two things about "
                  "the printed text are worth knowing before reading it: step 1 opens "
                  "with the orphan fragment 'MΩ resistor in R1.', which belongs to the "
                  "end of step 4 ('check relay K5 and90.'), and step 3's Table 5-2 is "
                  "printed between steps 3 and 4 rather than inside step 3 — all five of "
                  "its resistances are carried as probe points instead. Both are covered "
                  "by caveats.",
    },
    "a6": {
        "id": "5-5",
        "title": "Troubleshooting the Wideband Oscillator Assembly (A6)",
        "source": "§5-5, 5700A/5720A Series II Service Manual, pages 5-42 to 5-47. One "
                  "section of fourteen steps and no sub-sections; the numbering here is "
                  "the manual's own, with step 1 shown above as the prerequisite "
                  "paragraph. "
                  "The section has two branch points, so it is rarely walked end to end: "
                  "step 2 says that if TP10 is right, skip to step 11, and step 4 says "
                  "that if TP15 is right, skip to step 10. Steps 2 to 10 are the "
                  "phase-locked loop and divider on sheet 1; steps 11 to 14 are the "
                  "amplitude control amplifier, the X10 stage and the filters on sheets 2 "
                  "and 3. Four of the five figures printed in its page range are waveforms "
                  "with boilerplate axis labels — see the caveat — and Table 5-1, which "
                  "step 10 cites, is carried as a table of its own rather than inside the "
                  "step. Note that the section's opening sentence says A5 where it means "
                  "A6; the heading is right.",
    },
}


def load(path, default=None):
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def strip_comments(obj):
    """Drop the _comment keys used to document the curated files."""
    if isinstance(obj, dict):
        return {k: strip_comments(v) for k, v in obj.items() if not k.startswith("_")}
    if isinstance(obj, list):
        return [strip_comments(v) for v in obj]
    return obj


def sort_ref(ref):
    """'TP9' before 'TP10' -- designators sort by prefix then numerically."""
    m = re.match(r"^([A-Z]+)(\d+)$", ref)
    return (m.group(1), int(m.group(2))) if m else (ref, 0)


def zone_for(sheet, x, y):
    """Map a normalised sheet position to its printed grid zone, e.g. 'C4'."""
    frame = sheet.get("grid", {}).get("frame")
    cols = sheet.get("grid", {}).get("cols")
    rows = sheet.get("grid", {}).get("rows")
    if not frame or not cols or not rows:
        return None
    fx = (x - frame["x0"]) / (frame["x1"] - frame["x0"])
    fy = (y - frame["y0"]) / (frame["y1"] - frame["y0"])
    if not (0 <= fx <= 1 and 0 <= fy <= 1):
        return None
    col = cols[min(len(cols) - 1, max(0, int(fx * len(cols))))]
    row = rows[min(len(rows) - 1, max(0, int(fy * len(rows))))]
    return "%s%s" % (row, col)


def merge_rails(rails, circuits):
    """Attach each rail's circuit description to its display record."""
    out = {}
    for key, rail in rails.items():
        rec = dict(rail)
        if key in circuits:
            rec["circuit"] = circuits[key]
        out[key] = rec
    return out


def build(asm):
    extracted = load(os.path.join(ROOT, ".build", asm, "extracted.json"))
    if not extracted:
        sys.exit("no .build/%s/extracted.json -- run tools/build_data.py first" % asm)
    curated = strip_comments(load(os.path.join(ROOT, "data", "%s.testpoints.json" % asm), {}))
    reference = strip_comments(load(os.path.join(ROOT, "data", "%s.reference.json" % asm), {}))
    # Which rail each capacitor sits on. Optional: a board with no audit yet
    # simply has no margins to show, which is different from having good ones.
    cap_audit = strip_comments(load(os.path.join(ROOT, "data", "%s.caps.json" % asm), {}))
    coords = load(os.path.join(ROOT, "data", "%s.coords.json" % asm), {}) or {}

    sheets = [dict(s) for s in SHEETS[asm]]
    for s in sheets:
        if s["id"] in coords.get("sheets", {}):
            s["grid"] = coords["sheets"][s["id"]].get("grid")

    layers = [dict(l) for l in LAYERS[asm]]
    for l in layers:
        l["transform"] = coords.get("layers", {}).get(l["id"], {}).get("transform") \
            or ("identity" if l["id"] == "drawing" else None)
        landmarks = coords.get("layers", {}).get(l["id"], {}).get("landmarks")
        if landmarks:
            l["landmarks"] = landmarks
        # An alignment solved from four corner pairs, or from one half of a
        # board because a shield covers the other, is a starting alignment and
        # the dataset should say so rather than presenting it as measured.
        if coords.get("layers", {}).get(l["id"], {}).get("approximate"):
            l["approximate"] = True

    placement = coords.get("placement", {})
    not_on_drawing = set(coords.get("notOnDrawing", []))

    def geometry_for(ref):
        p = placement.get(ref, {})
        out = {}
        if p.get("board"):
            out["board"] = p["board"]
        if p.get("sch"):
            sch = []
            for entry in p["sch"]:
                e = dict(entry)
                sheet = next((s for s in sheets if s["id"] == e.get("sheet")), None)
                if sheet:
                    zone = zone_for(sheet, e.get("x", -1), e.get("y", -1))
                    if zone:
                        e["zone"] = zone
                sch.append(e)
            out["sch"] = sch
        for flag in ("verified", "schVerified"):
            if p.get(flag):
                out[flag] = True
        # How the position was arrived at, so the app can say so rather than
        # presenting a machine-read marker as though someone had checked it.
        for key in ("placement", "placementNote"):
            if p.get(key):
                out[key] = p[key]
        if ref in not_on_drawing:
            out["notOnDrawing"] = True
        return out

    tp_by_ref = {t["ref"]: t for t in curated.get("testpoints", [])}
    component_notes = reference.get("componentNotes", {})

    components, testpoints = [], []
    for part in extracted["components"]:
        ref = part["ref"]
        rec = {k: v for k, v in part.items() if v not in (None, False, "")}
        rec.pop("qty", None) if rec.get("qty") is None else None
        # A function note beats the parts-list description for telling someone
        # what a part is for, so it is carried alongside rather than merged in.
        if ref in component_notes:
            rec["function"] = component_notes[ref]
        rec.update(geometry_for(ref))
        if ref in tp_by_ref:
            # A test point is a BOM line and an expectation record at once.
            merged = dict(tp_by_ref[ref])
            merged["desc"] = part["desc"]
            merged["fluke"] = part.get("fluke")
            if part.get("mfrPart"):
                merged["mfrPart"] = part["mfrPart"]
            merged.update(geometry_for(ref))
            testpoints.append(merged)
        else:
            components.append(rec)

    # A test point does not have to be a purchasable part. On A17 only nine of
    # the thirty-three are on the parts list -- the wire loops, stock 816090 --
    # and the rest are plated eyelets in the board itself. They are real probe
    # targets with real expectations, so they belong in the dataset; what they
    # lack is a BOM line, not a reason to exist.
    in_bom = {p["ref"] for p in extracted["components"]}
    for ref in sorted(tp_by_ref, key=sort_ref):
        if ref in in_bom:
            continue
        merged = dict(tp_by_ref[ref])
        merged["kind"] = merged.get("kind") or "testpoint"
        merged["notInParts"] = True
        merged.update(geometry_for(ref))
        testpoints.append(merged)
    testpoints.sort(key=lambda t: sort_ref(t["ref"]))

    steps = []
    for s in extracted["procedureSteps"]:
        # A step can name a test point that belongs to a DIFFERENT assembly.
        # A15's step 7 says "connect a jumper from TP9 to TP10 on the DAC
        # assembly" -- and A15 has its own TP9 and TP10, which are VI+ and VI-.
        # Left alone, the app offers those as clickable points on this board and
        # following them shorts the 2.2 A supply rails together. The reference
        # file names them per step so the chip is not offered; the sentence
        # still says what to do, and a caveat says why the link is absent.
        foreign = set((reference.get("foreignStepRefs") or {}).get(str(s["n"]), []))
        step = {"n": s["n"], "text": s["text"],
                "refs": [r for r in s["refs"] if r not in foreign]}
        # Where a board's troubleshooting is printed as more than one section
        # and the steps have been renumbered into one sequence, the step still
        # has to say which section to look in -- A14's step 12 is §5-20 step 3
        # in the manual, and a reader who cannot get from one to the other has
        # been given a number that exists nowhere in the book.
        if s.get("section"):
            step["section"] = s["section"]
        steps.append(step)

    # The first "step" of a Chapter 5 section is its prerequisite paragraph, not
    # a measurement. An assembly with no numbered section gets no procedure at
    # all rather than an empty shell that looks like missing data.
    proc = PROCEDURES.get(asm)
    procedures = [dict(proc,
                       prereq=steps[0]["text"] if steps else "",
                       steps=steps[1:] if steps else [])] if proc and steps else []

    dataset = {
        "id": extracted["id"],
        "name": extracted["name"],
        "pca": extracted["pca"],
        "rev": extracted["rev"],
        "refs": META[asm]["refs"],
        "warnings": META[asm]["warnings"],
        # A board that cannot come out of the instrument on its own: the two
        # SIP daughter cards are soldered to their parent boards, and the rear
        # panel is part of the chassis. The instrument-configuration log
        # offers no tick box for these, since "removed" is not a state they
        # can be in while the instrument is on the bench.
        "fixed": bool(META[asm].get("fixed")),
        "layers": layers,
        "schematics": sheets,
        "overview": reference.get("overview"),
        "rails": merge_rails(curated.get("rails", {}), reference.get("railCircuits", {})),
        "faultCodes": reference.get("faultCodes", []),
        "caveats": reference.get("caveats", []),
        # Reference tables shown verbatim. One key per table the manuals print
        # inside a section rather than as a measurement -- A16's Table 2-13, A15's
        # current limits, and A6's Table 5-1, which §5-5 step 10 cites by name and
        # which is a grid of logic levels rather than anything a step can state.
        # The renderer is generic over the row keys, so a new table needs no
        # engine change; only its key has to be named here.
        "tables": [t for t in [reference.get("paSupplySettings"),
                               reference.get("currentLimit"),
                               reference.get("muxSelect")] if t],
        "components": components,
        "testpoints": testpoints,
        "probePoints": curated.get("probePoints", []),
        "capAudit": cap_audit.get("caps", {}),
        "procedures": procedures,
    }

    out_path = os.path.join(ROOT, "data", "%s.js" % asm)
    body = json.dumps(dataset, indent=1, ensure_ascii=False)
    with open(out_path, "w", encoding="utf-8") as f:
        # Every board cited A18's table and section here, because the header was
        # written when A18 was the only board. The right strings are already in
        # scope, one per assembly.
        refs = (META.get(asm) or {}).get("refs") or {}
        parts_ref = refs.get("parts") or "the parts list"
        section = refs.get("troubleshooting")
        f.write("// Generated by tools/assemble.py -- do not hand-edit.\n")
        f.write("// Sources: %s%s (1996 Series II service manual),\n"
                % (parts_ref, " and " + section if section else ""))
        f.write("//          %s of the Rev 9 manual (manufacturer columns, OCR),\n"
                % parts_ref)
        f.write("//          data/%s.testpoints.json (curated), data/%s.coords.json (geometry).\n"
                % (asm, asm))
        f.write("// Author Mode exports a replacement for data/%s.coords.json.\n\n" % asm)
        f.write("BoardExplorer.register(%s);\n" % body)

    placed = sum(1 for c in components + testpoints if c.get("board"))
    verified = sum(1 for c in components + testpoints if c.get("verified"))
    sch_placed = sum(1 for c in components + testpoints if c.get("sch"))
    print("wrote data/%s.js" % asm)
    print("  components      %d" % len(components))
    print("  test points     %d" % len(testpoints))
    print("  probe points    %d" % len(dataset["probePoints"]))
    print("  procedure steps %d" % (len(procedures[0]["steps"]) if procedures else 0))
    print("  fault codes     %d" % len(dataset["faultCodes"]))
    print("  board placed    %d / %d  (%d verified)"
          % (placed, len(components) + len(testpoints), verified))
    print("  schematic placed %d / %d" % (sch_placed, len(components) + len(testpoints)))
    off_bom = [t["ref"] for t in testpoints if t.get("notInParts")]
    if off_bom:
        print("  test points with no parts-list line: %s" % ", ".join(off_bom))


if __name__ == "__main__":
    build(sys.argv[1] if len(sys.argv) > 1 else "a18")

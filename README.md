# Land Cover Agreement Scripts
This repository contains Google Earth Engine (GEE) scripts for evaluating agreement between manually labeled reference points and land cover products including LCMS, WorldCover, and Dynamic World. The workflow supports mixed‑pixel remapping experiments, multi‑year comparisons, and automated confusion matrix generation.


# Scripts Included
- LCMS_MixedPixelCombos.js — runs 8 mixed‑pixel remapping versions and evaluates agreement for LCMS Land Cover

- WorldCover_Accuracy.js — runs 8 mixed-pixel remapping versions and evaluates agreement for 2020–2021 WorldCover

- DynamicWorld_MultiYear.js — evaluates agreement for Dynamic World across 2015–2025 using probability bands


# Requirements
- Google Earth Engine account

- Reference point CSV containing at least:
  - lat
  - lon
  - label
  - optional: PSU/SSU identifiers


# Quick Start
1) Upload your labeled CSV to GEE as a table asset
2) Update the POINTS_ASSET variable in any script
3) Run the script
4) Export results from the Tasks panel

# Citation
If you use this repository, cite:
Hood, Claire (2026). Land Cover Agreement Scripts. GitHub Repository.  
Repository URL: https://github.com/clairehood/land_cover_agreement_scripts

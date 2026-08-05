/*
==========================================================================
 ACCURACY ASSESSMENT: Reference labels (LCMS Labels) vs Dynamic World V1 (10m)
 Looped across years 2015-2025
==========================================================================

DYNAMIC WORLD PURE CLASSES (codes 0-8):
  0 water | 1 trees | 2 grass | 3 flooded_vegetation | 4 crops
  5 shrub_and_scrub | 6 built | 7 bare | 8 snow_and_ice

UNIFIED 13-CATEGORY SCHEME (same categories used on BOTH matrix axes):
  Codes 0-8  = the 9 pure DW classes above
  Code 9     = Majority 2: Barren & Trees   (was barren_tree_mix)
  Code 10    = Majority 2: Grass & Barren   (was barren_grass_mix)
  Code 11    = Majority 2: Trees & Grass    (was grass_tree_mix)
  Code 12    = Majority 2: Grass & Shrub    (was grass_shrub_mix)

  Reference side (fixed per raw label — see LABEL_TO_FINAL_CODE):
    tree->Trees, grass_forb_herb->Grass, barren_impervious->Built,
    water->Water, and all 4 _mix labels -> their own Majority-2 row.

  Predicted side (per point, from DW's own probabilities — see
  addFinalPredCode): if DW's top-1 probability >= MIXED_PROB_THRESHOLD,
  predicted = DW's pure top-1 class. If below threshold, check whether
  DW's {top-1,top-2} pair matches one of the 4 known Majority-2 pairs; if
  so, predicted = that Majority-2 category. If DW is uncertain but between
  two classes nobody ever labeled as a pair, NO catch-all bucket — it just
  falls back to DW's pure top-1 class.

  IMPORTANT CAVEAT: "mixed" means two different things on each axis: 
  reference-side mixed is a human's visual judgment call; predicted-side
  mixed is a statistical confidence threshold on the classifier. This
  matrix asks whether the map's statistical uncertainty tracks the
  labeler's perceptual uncertainty.

PROBABILITY-BASED DIAGNOSTICS (Sections 3/3b, independent of the matrix
above): soft_match, top2_match, dw_entropy, dw_margin — see comments there.

// ---------------------- 1. CONFIG ----------------------

var POINTS_ASSET = 'projects/your_project_name/assets/YOUR_ASSET_NAME';  // <-- update

var YEARS = [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
var YEARS = [2024]; // <-- uncomment to test with just 1 year first

var DW_BANDS = ['water','trees','grass','flooded_vegetation','crops','shrub_and_scrub','built','bare','snow_and_ice'];
var DW_CLASS_NAMES = ['Water','Trees','Grass','Flooded vegetation','Crops','Shrub & scrub','Built','Bare','Snow & ice'];

var MIXED_PROB_THRESHOLD = 0.90; // DW top-1 prob below this = "uncertain"
var SCALE = 10; // Dynamic World native resolution

// ---- The 4 Majority-2 categories (the ones you actually labeled with) ----
var MAJORITY2_DEFS = [
  {codes: [7, 1], finalCode: 9,  name: 'Majority 2: Barren & Trees'},
  {codes: [7, 2], finalCode: 10, name: 'Majority 2: Grass & Barren'},
  {codes: [1, 2], finalCode: 11, name: 'Majority 2: Trees & Grass'},
  {codes: [2, 5], finalCode: 12, name: 'Majority 2: Grass & Shrub'}
];

var FINAL_CLASS_CODES = [0,1,2,3,4,5,6,7,8,9,10,11,12];
var FINAL_CLASS_NAMES = DW_CLASS_NAMES.concat(MAJORITY2_DEFS.map(function(d) { return d.name; }));

// pairKey (lo*100+hi) -> final code, for routing uncertain DW predictions
var PAIR_TO_FINAL_CODE_OBJ = {};
MAJORITY2_DEFS.forEach(function(d) {
  var lo = Math.min(d.codes[0], d.codes[1]);
  var hi = Math.max(d.codes[0], d.codes[1]);
  PAIR_TO_FINAL_CODE_OBJ[String(lo * 100 + hi)] = d.finalCode;
});
var PAIR_TO_FINAL_CODE = ee.Dictionary(PAIR_TO_FINAL_CODE_OBJ);

// ---- Reference side: raw label -> final class code (fixed, one-time) ----
var LABEL_TO_FINAL_CODE = ee.Dictionary({
  'tree': 1,
  'grass_forb_herb': 2,
  'barren_impervious': 6,
  'water': 0,
  'grass_shrub_mix': 12,
  'barren_tree_mix': 9,
  'barren_grass_mix': 10,
  'grass_tree_mix': 11
});

// ---- Reference "component" classes for the probability-based diagnostics ----
// (Sections 3/3b) — kept separate from the matrix scheme above since these
// still carry useful info even for grass_shrub_mix, which the matrix folds away.
var REF_COMPONENTS = ee.Dictionary({
  'tree': [1],
  'grass_forb_herb': [2],
  'barren_impervious': [6],
  'water': [0],
  'grass_shrub_mix': [2, 5],
  'barren_tree_mix': [7, 1],
  'barren_grass_mix': [7, 2],
  'grass_tree_mix': [1, 2]
});
var MIXED_LABELS = ['grass_shrub_mix', 'barren_tree_mix', 'barren_grass_mix', 'grass_tree_mix'];
var PURE_LABELS = ['tree', 'grass_forb_herb', 'barren_impervious', 'water'];

// ---------------------- 2. LOAD REFERENCE POINTS (once, not per year) ----------------------

var allPoints = ee.FeatureCollection(POINTS_ASSET);
var labeled = allPoints.filter(ee.Filter.neq('label', ''));
print('Labeled reference points (expect 3600):', labeled.size());

var withRefCode = labeled.map(function(f) {
  return f.set('ref_final_code', LABEL_TO_FINAL_CODE.get(f.get('label')));
});

// Hardcoded PSU-01..PSU-36 list (all 36 confirmed labeled) — avoids any
// per-year server round-trip to discover which PSUs have data.
function psuIdList() {
  var out = [];
  for (var i = 1; i <= 36; i++) {
    out.push('PSU-' + (i < 10 ? '0' + i : i));
  }
  return out;
}
var PSU_IDS = psuIdList();

// ---------------------- 3. BUILD ANNUAL DYNAMIC WORLD COMPOSITE ----------------------
// Average the per-class probability bands across the year's images, then
// take the argmax band-wise (Google's recommended compositing approach —
// smoother than the mode of single-date discrete labels). Also derives:
//   dw_top1_prob  — the winning class's probability (drives the threshold)
//   dw_top2_label — the runner-up class
//   dw_margin     — gap between top-1 and top-2 probability
//   dw_entropy    — Shannon entropy across all 9 classes
// NOTE: uses ee.Image array algebra (toArray/arraySort/arrayArgmax) — more
// advanced than the rest of the script. Sanity-check outputs on a small
// test run (YEARS = [2024]) before trusting the full loop.

function buildDwAnnualComposite(year) {
  var start = ee.Date.fromYMD(year, 1, 1);
  var end = start.advance(1, 'year');
  var dw = ee.ImageCollection('GOOGLE/DYNAMICWORLD/V1')
    .filterDate(start, end)
    .select(DW_BANDS);
  var meanProb = dw.mean(); // 9 probability bands, band order = DW_BANDS

  var arr = meanProb.toArray(); // 1-D array image, length 9
  var n = DW_BANDS.length;
  var sortedAsc = arr.arraySort(); // ascending order
  var top1Prob = sortedAsc.arrayGet([n - 1]).rename('dw_top1_prob');
  var top2Prob = sortedAsc.arrayGet([n - 2]);
  var margin = top1Prob.subtract(top2Prob).rename('dw_margin');

  var top1Idx = arr.arrayArgmax().arrayGet([0]).rename('dw_label');

  // Top-2 class index: GEE's .where() rejects an array-valued test image
  // (that's what caused the "bands may not be array valued" error), so
  // instead of masking the whole 9-element array at once, mask each class
  // band individually as a plain scalar image, then reassemble and argmax.
  // (Rare edge case: an exact probability tie for 1st place could blank
  // more than one entry — not corrected for, flagged here for awareness.)
  var maskedBands = [];
  for (var i = 0; i < n; i++) {
    var bandProb = meanProb.select([DW_BANDS[i]]);      // scalar image
    var isThisTop1 = bandProb.eq(top1Prob);              // scalar test — valid
    maskedBands.push(bandProb.where(isThisTop1, -1).rename('m' + i));
  }
  var maskedArr = ee.Image.cat(maskedBands).toArray(); // same band order as DW_BANDS
  var top2Idx = maskedArr.arrayArgmax().arrayGet([0]).rename('dw_top2_label');

  // Shannon entropy across the 9-class distribution (natural log; clamp to
  // avoid log(0) for classes with ~zero probability).
  var arrSafe = arr.max(1e-6);
  var entropyArr = arrSafe.multiply(arrSafe.log()).multiply(-1);
  var entropy = entropyArr.arrayReduce(ee.Reducer.sum(), [0]).arrayGet([0]).rename('dw_entropy');

  return meanProb.addBands(top1Idx).addBands(top1Prob).addBands(top2Idx).addBands(margin).addBands(entropy);
}

// ---------------------- 3b. PER-POINT PROBABILITY-BASED METRICS ----------------------

function addSoftMetrics(f) {
  var comps = ee.List(REF_COMPONENTS.get(f.get('label')));

  // Soft match: how much DW probability mass falls on ANY class this
  // label's mixture plausibly includes (1 class for pure labels, 2 for
  // mixed labels). Bounded 0-1.
  var softMatch = ee.Number(comps.iterate(function(code, acc) {
    var bandName = ee.List(DW_BANDS).get(ee.Number(code));
    return ee.Number(acc).add(ee.Number(f.get(bandName)));
  }, 0));

  var top1 = f.get('dw_label');
  var top2 = f.get('dw_top2_label');
  var hit1 = comps.indexOf(top1).neq(-1);
  var hit2 = comps.indexOf(top2).neq(-1);
  var top2Match = hit1.or(hit2);

  var isMixed = ee.List(MIXED_LABELS).indexOf(f.get('label')).neq(-1);

  return f.set({
    'soft_match': softMatch,
    'top2_match': top2Match,
    'is_mixed_label': isMixed
  });
}

// ---------------------- 3c. PREDICTED-SIDE FINAL CLASS (matrix column) ----------------------

function addFinalPredCode(f) {
  var top1Prob = ee.Number(f.get('dw_top1_prob'));
  var top1 = ee.Number(f.get('dw_label'));
  var top2 = ee.Number(f.get('dw_top2_label'));

  var lo = top1.min(top2);
  var hi = top1.max(top2);
  var pairKey = lo.multiply(100).add(hi).format();

  var predCode = ee.Algorithms.If(
    top1Prob.gte(MIXED_PROB_THRESHOLD),
    top1,
    PAIR_TO_FINAL_CODE.get(pairKey, top1) // no catch-all: falls back to pure top1
  );

  return f.set('pred_final_code', predCode);
}

// ---------------------- 4. PER-YEAR PROCESSING ----------------------

function processYear(year) {
  var dwImage = buildDwAnnualComposite(year);

  var sampled = dwImage.sampleRegions({
    collection: withRefCode,
    properties: ['ref_final_code', 'psu', 'ssu', 'label'],
    scale: SCALE,
    geometries: true
  }).map(function(f) { return f.set('year', year); })
    .map(addSoftMetrics)
    .map(addFinalPredCode);

  // ---- Unified 13x13 confusion matrix (same categories both axes) ----
  var confMatrix = sampled.errorMatrix('ref_final_code', 'pred_final_code', FINAL_CLASS_CODES);

  // ---- Probability-based diagnostics (independent of the matrix above) ----
  var meanSoftMatch = sampled.aggregate_mean('soft_match');
  var top2Accuracy = sampled.aggregate_mean('top2_match');
  var mixedPts = sampled.filter(ee.Filter.eq('is_mixed_label', 1));
  var purePts = sampled.filter(ee.Filter.eq('is_mixed_label', 0));
  var meanEntropyMixed = mixedPts.aggregate_mean('dw_entropy');
  var meanEntropyPure = purePts.aggregate_mean('dw_entropy');
  var meanMarginMixed = mixedPts.aggregate_mean('dw_margin');
  var meanMarginPure = purePts.aggregate_mean('dw_margin');

  print('Year ' + year + ' — OA:', confMatrix.accuracy(), 'Kappa:', confMatrix.kappa(),
        '| Soft match:', meanSoftMatch, '| Top-2 acc:', top2Accuracy,
        '| Entropy mixed-labeled pts:', meanEntropyMixed, 'vs pure-labeled pts:', meanEntropyPure);

  var matrixFeature = ee.Feature(null, {
    year: year,
    threshold: MIXED_PROB_THRESHOLD,
    matrix: confMatrix.array(),
    mean_soft_match: meanSoftMatch,
    top2_accuracy: top2Accuracy,
    mean_entropy_mixed_labels: meanEntropyMixed,
    mean_entropy_pure_labels: meanEntropyPure,
    mean_margin_mixed_labels: meanMarginMixed,
    mean_margin_pure_labels: meanMarginPure
  });

  // ---- Per-PSU summary table (flattened, no console spam) ----
  var perPsuFeatures = PSU_IDS.map(function(psuId) {
    var psuPoints = sampled.filter(ee.Filter.eq('psu', psuId));
    var cm = psuPoints.errorMatrix('ref_final_code', 'pred_final_code', FINAL_CLASS_CODES);
    var matrixArray = cm.array();
    var prodAcc = cm.producersAccuracy(); // Nx1
    var userAcc = cm.consumersAccuracy(); // 1xN

    var props = ee.Dictionary({
      'year': year,
      'psu': psuId,
      'n_points': psuPoints.size(),
      'overall_accuracy': cm.accuracy(),
      'kappa': cm.kappa(),
      'soft_match_mean': psuPoints.aggregate_mean('soft_match'),
      'top2_accuracy': psuPoints.aggregate_mean('top2_match')
    });

    FINAL_CLASS_CODES.forEach(function(refCode, i) {
      FINAL_CLASS_CODES.forEach(function(predCode, j) {
        props = props.set('ref' + refCode + '_pred' + predCode, matrixArray.get([i, j]));
      });
    });
    FINAL_CLASS_CODES.forEach(function(code, i) {
      props = props.set('PA_' + code, prodAcc.get([i, 0]));
      props = props.set('UA_' + code, userAcc.get([0, i]));
    });

    return ee.Feature(null, props);
  });
  var perPsuTable = ee.FeatureCollection(perPsuFeatures);

  // ---- Exports (3 per year) ----
  var thrTag = 'thr' + Math.round(MIXED_PROB_THRESHOLD * 100);

  Export.table.toDrive({
    collection: ee.FeatureCollection([matrixFeature]),
    description: 'ConfusionMatrix_Pooled_DW_' + year + '_' + thrTag,
    fileFormat: 'CSV'
  });

  Export.table.toDrive({
    collection: perPsuTable,
    description: 'ConfusionMatrix_PerPSU_DW_' + year + '_' + thrTag,
    fileFormat: 'CSV'
  });

  Export.table.toDrive({
    collection: sampled,
    description: 'SampledPoints_RefVsDW_' + year + '_' + thrTag,
    fileFormat: 'CSV'
  });
}

// ---------------------- 5. LOOP OVER YEARS ----------------------

for (var y = 0; y < YEARS.length; y++) {
  processYear(YEARS[y]);
}

print('Final class order (codes):', FINAL_CLASS_CODES, '(names):', FINAL_CLASS_NAMES);
print('Queued exports for years:', YEARS, '— go to the Tasks tab and click Run on each (3 per year).');


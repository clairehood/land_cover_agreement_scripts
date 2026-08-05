/*
==========================================================================
 ACCURACY ASSESSMENT: Reference labels (USFS Land Cover Legend) vs 
 USFS LCMS Land Cover
==========================================================================

This script runs 8 remapping combinations (V4..V11) for combining mixed pixel
classifications into single classes and exports 3 products per combination: 
pooled confusion matrix, per-PSU summary table, and sampled points (24 total 
exports).

List of Combinations (barren & tree mix = BT; tree & grass mix = GT; barren & grass 
mix = BG): 
V4: BT→barren, BG→barren, GT→grass
V5: BT→tree, BG→barren, GT→grass
V6: BT→barren, BG→grass, GT→grass
V7: BT→tree, BG→grass, GT→grass
V8: BT→barren, BG→barren, GT→tree 
V9: BT→tree, BG→barren, GT→tree
V10: BT→barren, BG→grass, GT→tree 
V11: BT→tree, BG→grass, GT→tree


*/

// ---------------------- 1. CONFIG ----------------------

var POINTS_ASSET = 'projects/your_project_name/assets/YOUR_ASSET_NAME'; // <-- Replace with your Asset ID
var YEAR = 2023; // <-- Ensure this matches your year
var STUDY_AREA = 'CONUS'; // <-- Ensure this matches your study area
var RUNNUM = 'AOI1'; // <-- Write any identification label here. Feel free to delete this variable if you so desire.

// ---------------------- 2. LOAD REFERENCE POINTS ----------------------

var allPoints = ee.FeatureCollection(POINTS_ASSET);

// Keep only SSUs that have actually been labeled
var labeled = allPoints.filter(ee.Filter.neq('label', ''));
print('Labeled reference points:', labeled.size()); // expect only labeled SSUs

// ---------------------- 3. CONSTANTS AND LOOKUPS ----------------------
// USFS LCMS Land_Cover class table (from the EE data catalog):
//  1 Trees | 4 Grass/Forb/Herb & Trees Mix | 5 Barren & Trees Mix
//  8 Grass/Forb/Herb & Shrubs Mix | 10 Grass/Forb/Herb
//  11 Barren & Grass/Forb/Herb Mix | 12 Barren or Impervious | 14 Water

var CODE_TO_NAME = ee.Dictionary({
  '1': 'Trees', '4': 'Grass/Forb/Herb & Trees Mix', '5': 'Barren & Trees Mix',
  '8': 'Grass/Forb/Herb & Shrubs Mix', '10': 'Grass/Forb/Herb',
  '11': 'Barren & Grass/Forb/Herb Mix', '12': 'Barren or Impervious', '14': 'Water'
});

// Class order used for matrices (rows = reference, cols = map)
var classOrder = [1, 4, 5, 8, 10, 11, 12, 14];

// ---------------------- 4. LOAD THE PRODUCER MAP (LCMS Land Cover) ----------------------

var lcms = ee.ImageCollection('projects/gtac-data-publish/assets/LCMS/Product_Version/2025-11')
  .filterDate(String(YEAR), String(YEAR + 1))
  .filter(ee.Filter.eq('study_area', STUDY_AREA))
  .first()
  .select('Land_Cover');

// ---------------------- 5. REMAPPING COMBINATIONS ----------------------
// Each dictionary sets how the three mixed reference labels are recoded.
// Order: V4..V11 (index 0 -> V4)
var remaps = [
  ee.Dictionary({'grass_tree_mix': 10, 'barren_tree_mix': 12, 'barren_grass_mix': 12}),
  ee.Dictionary({'grass_tree_mix': 10, 'barren_tree_mix': 1,  'barren_grass_mix': 12}),
  ee.Dictionary({'grass_tree_mix': 10, 'barren_tree_mix': 12, 'barren_grass_mix': 10}),
  ee.Dictionary({'grass_tree_mix': 10, 'barren_tree_mix': 1,  'barren_grass_mix': 10}),
  ee.Dictionary({'grass_tree_mix': 1,  'barren_tree_mix': 12, 'barren_grass_mix': 12}),
  ee.Dictionary({'grass_tree_mix': 1,  'barren_tree_mix': 1,  'barren_grass_mix': 12}),
  ee.Dictionary({'grass_tree_mix': 1,  'barren_tree_mix': 12, 'barren_grass_mix': 10}),
  ee.Dictionary({'grass_tree_mix': 1,  'barren_tree_mix': 1,  'barren_grass_mix': 10})
];

// ---------------------- 6. LOOP THROUGH REMAPS AND EXPORT ----------------------

remaps.forEach(function(remap, index) {

  var version = 'V' + (index + 4); // V4..V11

  print('======================================');
  print('Running', version);
  print('Remap dictionary:', remap);
  print('======================================');

  // Build LABEL_TO_CODE dynamically for this remap
  var LABEL_TO_CODE = ee.Dictionary({
    'tree': 1,
    'grass_tree_mix': remap.get('grass_tree_mix'),
    'barren_tree_mix': remap.get('barren_tree_mix'),
    'grass_shrub_mix': 8,
    'grass_forb_herb': 10,
    'barren_grass_mix': remap.get('barren_grass_mix'),
    'barren_impervious': 12,
    'water': 14
  });

  // Apply mapping to labeled points
  var withRefCode = labeled.map(function(f) {
    return f.set('ref_code', LABEL_TO_CODE.get(f.get('label')));
  });

  // Sample LCMS at reference points
  var sampled = lcms.sampleRegions({
    collection: withRefCode,
    properties: ['ref_code', 'psu', 'ssu', 'label'],
    scale: 30,
    geometries: true
  });

  print(version + ' Sampled points (first 5):', sampled.limit(5));

  // Compute pooled confusion matrix
  var confMatrix = sampled.errorMatrix('ref_code', 'Land_Cover', classOrder);

  print(version + ' Confusion Matrix (rows = reference, cols = LCMS map):', confMatrix);
  print(version + ' Class order (codes):', classOrder);
  print(version + ' Class order (names):', classOrder.map(function(c) { return CODE_TO_NAME.get(c.toString()); }));
  print(version + ' Overall Accuracy:', confMatrix.accuracy());
  print(version + " Producer's Accuracy:", confMatrix.producersAccuracy());
  print(version + " User's Accuracy:", confMatrix.consumersAccuracy());
  print(version + ' Kappa:', confMatrix.kappa());

  // Build per-PSU summary table (server-side)
  var psuList = sampled.aggregate_array('psu').distinct().sort();

  var perPsuFeatures = ee.List(psuList).map(function(psuId) {
    psuId = ee.String(psuId);
    var psuPoints = sampled.filter(ee.Filter.eq('psu', psuId));
    var cm = psuPoints.errorMatrix('ref_code', 'Land_Cover', classOrder);
    var matrixArray = cm.array();
    var prodAcc = cm.producersAccuracy();
    var userAcc = cm.consumersAccuracy();

    var props = ee.Dictionary({
      'psu': psuId,
      'n_points': psuPoints.size(),
      'overall_accuracy': cm.accuracy(),
      'kappa': cm.kappa()
    });

    // Flatten confusion matrix cells: ref_<code>_pred_<code>
    classOrder.forEach(function(refCode, i) {
      classOrder.forEach(function(predCode, j) {
        props = props.set('ref' + refCode + '_pred' + predCode, matrixArray.get([i, j]));
      });
    });

    // Per-class producer's / user's accuracy
    classOrder.forEach(function(code, i) {
      props = props.set('PA_' + code, prodAcc.get([i, 0]));
      props = props.set('UA_' + code, userAcc.get([0, i]));
    });

    return ee.Feature(null, props);
  });

  var perPsuTable = ee.FeatureCollection(perPsuFeatures);
  print(version + ' Per-PSU table preview:', perPsuTable.limit(5));

  // ---------------------- EXPORTS ----------------------
  // 1) Pooled confusion matrix
  var matrixFeature = ee.Feature(null, {matrix: confMatrix.array()});
  Export.table.toDrive({
    collection: ee.FeatureCollection([matrixFeature]),
    description: RUNNUM + version + 'ConfusionMatrix_Pooled_LCMS_' + YEAR,
    fileFormat: 'CSV'
  });

  // 2) Per-PSU table
  Export.table.toDrive({
    collection: perPsuTable,
    description: RUNNUM + version + 'ConfusionMatrix_PerPSU_LCMS_' + YEAR,
    fileFormat: 'CSV'
  });

  // 3) Sampled points
  Export.table.toDrive({
    collection: sampled,
    description: RUNNUM + version + 'SampledPoints_RefVsLCMS_' + YEAR,
    fileFormat: 'CSV'
  });

}); // end remaps.forEach



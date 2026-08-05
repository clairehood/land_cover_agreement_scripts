// ============================================================
// LCMS vs WORLDCOVER VALIDATION
// ============================================================

// ============================================================
// LCMS → WORLDCOVER VARIANT LEGEND
// ============================================================
//
// Fixed conversions:
// tree → Tree (10) | water → Water (80) | grass_forb_herb → Grass (30)
// grass_shrub_mix → Grass (30) | barren_impervious → Built-up (50)
//
// Mixed pixel variants:
//
// Variant 0: barren_tree_mix → Built-up (50) + barren_grass_mix → Built-up (50) + grass_tree_mix → Grass (30)
// Variant 1: barren_tree_mix → Tree (10) + barren_grass_mix → Built-up (50) + grass_tree_mix → Grass (30)
// Variant 2: barren_tree_mix → Built-up (50) + barren_grass_mix → Grass (30) + grass_tree_mix → Grass (30)
// Variant 3: barren_tree_mix → Tree (10) + barren_grass_mix → Grass (30) + grass_tree_mix → Grass (30)
// Variant 4: barren_tree_mix → Built-up (50) + barren_grass_mix → Built-up (50) + grass_tree_mix → Tree (10)
// Variant 5: barren_tree_mix → Tree (10) + barren_grass_mix → Built-up (50) + grass_tree_mix → Tree (10)
// Variant 6: barren_tree_mix → Built-up (50) + barren_grass_mix → Grass (30) + grass_tree_mix → Tree (10)
// Variant 7: barren_tree_mix → Tree (10) + barren_grass_mix → Grass (30) + grass_tree_mix → Tree (10)
//
// ============================================================

// ===============================
// VERSION
// ===============================

var VERSION = 'LCMS_WC_V05';


// ===============================
// INPUTS
// ===============================


var csv = ee.FeatureCollection(
'projects/your_project_name/assets/YOUR_ASSET_NAME'
);


var wc2020 =
ee.Image('ESA/WorldCover/v100/2020')
.select('Map');


var wc2021 =
ee.Image('ESA/WorldCover/v200/2021')
.select('Map');



// ===============================
// REDUCE CSV SIZE
// ===============================


var samples = csv.map(function(f){

return ee.Feature(
    f.geometry(),
    {
      psu:f.get('psu'),
      ssu:f.get('ssu'),
      label:f.get('label'),
      lat:f.get('lat'),
      lon:f.get('lon')
    }
);

});


print(
'Number of samples:',
samples.size()
);


print(
'LCMS labels found:',
samples.aggregate_array('label').distinct()
);



// ============================================================
// LCMS BASE MAP
// ============================================================


var LCMS_BASE = {


tree:10,


water:80,


grass_forb_herb:30,


// user requested
// treat grass-shrub as grass
grass_shrub_mix:30,


// user requested
// barren -> built-up
barren_impervious:50


};



// ============================================================
// MIXED PIXELS
// ============================================================


var MIXED_OPTIONS = {


barren_tree_mix:
[
50,
10
],


barren_grass_mix:
[
50,
30
],


grass_tree_mix:
[
30,
10
]


};



// ============================================================
// CREATE 8 VARIANTS
// ============================================================


function createVariants(){


var variants=[];


for(var i=0;i<8;i++){


var dict =
ee.Dictionary(LCMS_BASE);



dict =
dict.set(
'barren_tree_mix',
MIXED_OPTIONS.barren_tree_mix[(i>>0)&1]
);



dict =
dict.set(
'barren_grass_mix',
MIXED_OPTIONS.barren_grass_mix[(i>>1)&1]
);



dict =
dict.set(
'grass_tree_mix',
MIXED_OPTIONS.grass_tree_mix[(i>>2)&1]
);



variants.push(dict);


}


return variants;

}



var variants=createVariants();



print(
'Number of variants:',
variants.length
);



// ============================================================
// APPLY LCMS → WORLDCOVER
// ============================================================


function convertLCMS(fc,dict,variant){


return fc.map(function(f){


var label =
f.getString('label');


var wc =
ee.Algorithms.If(
dict.contains(label),
dict.get(label),
-999
);



return f.set({

variant:variant,

lcms_original:label,

lcms_wc:wc

});


});


}



// ============================================================
// SAMPLE WORLDCOVER
// ============================================================


function addWorldCover(fc,image,year){


return image.reduceRegions({

collection:fc,

reducer:ee.Reducer.first(),

scale:10

})

.map(function(f){


return f.set(
'worldcover_'+year,
f.get('first')
);


});

}



// ============================================================
// CONFUSION MATRIX SETTINGS
// ============================================================


var WC_CLASSES =
[
10,
20,
30,
40,
50,
60,
70,
80,
90,
95,
100
];




// ============================================================
// METRICS
// ============================================================


function getMetrics(cm){


return {

accuracy:
cm.accuracy(),

kappa:
cm.kappa()

};

}



// ============================================================
// POOLED ACCURACY
// ============================================================


function pooledAccuracy(fc,year,variant){


var cm =
fc.errorMatrix(

'lcms_wc',

'worldcover_'+year,

WC_CLASSES

);



var m =
getMetrics(cm);



return ee.Feature(null,{

type:'POOLED',

year:year,

variant:variant,

samples:fc.size(),

confusion_matrix:
cm.array(),

overall_accuracy:
m.accuracy,

kappa:
m.kappa

});


}



// ============================================================
// PSU ACCURACY
// ============================================================


function psuAccuracy(fc,year,variant){


var psus =
fc.aggregate_array('psu')
.distinct();



return ee.FeatureCollection(

psus.map(function(p){


var subset =
fc.filter(
ee.Filter.eq('psu',p)
);



var cm =
subset.errorMatrix(

'lcms_wc',

'worldcover_'+year,

WC_CLASSES

);



var m =
getMetrics(cm);



return ee.Feature(null,{

type:'PSU',

psu:p,

year:year,

variant:variant,

samples:
subset.size(),

confusion_matrix:
cm.array(),

overall_accuracy:
m.accuracy,

kappa:
m.kappa

});


})


);


}



// ============================================================
// RUN EACH VARIANT
// ============================================================


variants.forEach(function(dict,variant){



print(
'Running variant:',
variant
);



var converted =
convertLCMS(
samples,
dict,
variant
);



// =====================
// 2020
// =====================


var data2020 =
addWorldCover(
converted,
wc2020,
2020
)
.filter(
ee.Filter.neq(
'lcms_wc',
-999
)
)
.filter(
ee.Filter.notNull(
[
'worldcover_2020'
]
)
);



var accuracy2020 =
ee.FeatureCollection([

pooledAccuracy(
data2020,
2020,
variant
)

])
.merge(
psuAccuracy(
data2020,
2020,
variant
)
);




// =====================
// 2021
// =====================


var data2021 =
addWorldCover(
converted,
wc2021,
2021
)
.filter(
ee.Filter.neq(
'lcms_wc',
-999
)
)
.filter(
ee.Filter.notNull(
[
'worldcover_2021'
]
)
);



var accuracy2021 =
ee.FeatureCollection([

pooledAccuracy(
data2021,
2021,
variant
)

])
.merge(
psuAccuracy(
data2021,
2021,
variant
)
);




// ============================================================
// EXPORT POINT DATA
// ============================================================


Export.table.toDrive({

collection:data2020,

description:
VERSION+
'_Variant_'+variant+
'_POINTS_2020',

fileFormat:'CSV'

});



Export.table.toDrive({

collection:data2021,

description:
VERSION+
'_Variant_'+variant+
'_POINTS_2021',

fileFormat:'CSV'

});




// ============================================================
// EXPORT CONFUSION DATA
// ============================================================


Export.table.toDrive({

collection:accuracy2020,

description:
VERSION+
'_Variant_'+variant+
'_CONFUSION_2020',

fileFormat:'CSV'

});



Export.table.toDrive({

collection:accuracy2021,

description:
VERSION+
'_Variant_'+variant+
'_CONFUSION_2021',

fileFormat:'CSV'

});



});



print(
'ALL EXPORT TASKS CREATED'
);


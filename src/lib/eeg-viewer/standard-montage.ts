import { BIOSEMI_128, BIOSEMI_256, GSN_HYDROCEL_129, GSN_HYDROCEL_257 } from "./net-montages";
import type { Vec3 } from "./topo";

/**
 * Standard-1005 electrode coordinates, vendored from MNE
 * `make_standard_montage("standard_1005").get_positions()["ch_pos"]` (head/MRI frame,
 * metres: +X right, +Y anterior/nasion, +Z up). 343 labels spanning the 10-20, 10-10,
 * and 10-05 systems.
 *
 * Purpose: a *fallback* scalp layout for the topomap. Many EEG datasets name standard
 * channel labels (Fp1, Cz, Oz, ...) but ship no `electrodes.tsv`, so the store carries
 * no coordinates. For those we project this standard montage, exactly as EEGLAB/MNE do
 * when you apply a named montage by label. Real measured positions (electrodes.tsv,
 * embedded by the converter into the store) always take precedence; this is consulted
 * only when the store has none.
 *
 * Absolute scale is irrelevant downstream: `projectPositions` least-squares-fits a
 * sphere and normalises to the unit sphere, so metres-vs-millimetres does not matter.
 * The frame is RAS, so it passes through `alsToRas` unchanged when tagged with a
 * non-ALS system (we use "").
 *
 * Labels this table can't place (EGI "E1", BioSemi "A1", purely numeric, EOG/EMG/
 * trigger names) fall through to a canonical named-net montage when the cap is
 * recognizable (`namedNetIndex` + `net-montages.ts`, #855); anything still
 * unresolved yields <3 channels and no topomap, rather than a misleading one.
 */
export const STANDARD_1005: Readonly<Record<string, Vec3>> = {
  A1: [-0.08608, -0.02499, -0.06799],
  A2: [0.08579, -0.02501, -0.06803],
  AF1: [-0.01847, 0.0799, 0.03275],
  AF10: [0.05044, 0.06387, -0.04801],
  AF10h: [0.05575, 0.06717, -0.02982],
  AF1h: [-0.0092, 0.08061, 0.03513],
  AF2: [0.01982, 0.0803, 0.03276],
  AF2h: [0.01048, 0.08086, 0.03536],
  AF3: [-0.0337, 0.07684, 0.02123],
  AF3h: [-0.02722, 0.07871, 0.02838],
  AF4: [0.03571, 0.07773, 0.02196],
  AF4h: [0.02858, 0.0793, 0.02847],
  AF5: [-0.04543, 0.07286, 0.00598],
  AF5h: [-0.03964, 0.07487, 0.01368],
  AF6: [0.04658, 0.07381, 0.00603],
  AF6h: [0.04094, 0.07574, 0.01386],
  AF7: [-0.05484, 0.06857, -0.01059],
  AF7h: [-0.05118, 0.07084, -0.00175],
  AF8: [0.05574, 0.06966, -0.01076],
  AF8h: [0.05203, 0.07185, -0.00192],
  AF9: [-0.04897, 0.06409, -0.04768],
  AF9h: [-0.05483, 0.06641, -0.0297],
  AFF1: [-0.02358, 0.06992, 0.04729],
  AFF10: [0.0606, 0.05227, -0.04904],
  AFF10h: [0.06433, 0.0546, -0.03044],
  AFF1h: [-0.01144, 0.07076, 0.05035],
  AFF2: [0.02556, 0.07056, 0.04783],
  AFF2h: [0.01348, 0.0712, 0.05117],
  AFF3: [-0.04338, 0.06637, 0.03281],
  AFF3h: [-0.03432, 0.06839, 0.04119],
  AFF4: [0.04515, 0.06727, 0.03273],
  AFF4h: [0.03618, 0.06915, 0.04125],
  AFF5: [-0.05582, 0.0614, 0.01188],
  AFF5h: [-0.0508, 0.06404, 0.02309],
  AFF6: [0.058, 0.0626, 0.0119],
  AFF6h: [0.0524, 0.06507, 0.02286],
  AFF7: [-0.06326, 0.05599, -0.01117],
  AFF7h: [-0.06135, 0.0588, 0.0009],
  AFF8: [0.06467, 0.05727, -0.01146],
  AFF8h: [0.06292, 0.06004, 0.00063],
  AFF9: [-0.05934, 0.05268, -0.04877],
  AFF9h: [-0.06325, 0.05386, -0.03032],
  AFFz: [0.00028, 0.07128, 0.05209],
  AFp1: [-0.01224, 0.08619, 0.01419],
  AFp10: [0.03771, 0.07217, -0.0462],
  AFp10h: [0.04382, 0.07654, -0.02831],
  AFp1h: [-0.00593, 0.08688, 0.0162],
  AFp2: [0.01362, 0.08676, 0.0153],
  AFp2h: [0.00711, 0.08707, 0.01647],
  AFp3: [-0.02235, 0.08356, 0.00607],
  AFp3h: [-0.01719, 0.08485, 0.01003],
  AFp4: [0.0241, 0.08438, 0.00743],
  AFp4h: [0.01892, 0.0856, 0.01144],
  AFp5: [-0.03328, 0.08121, -0.00114],
  AFp5h: [-0.02799, 0.08246, 0.0027],
  AFp6: [0.03391, 0.08181, -0.00103],
  AFp6h: [0.02864, 0.08298, 0.00283],
  AFp7: [-0.04351, 0.07858, -0.00924],
  AFp7h: [-0.03855, 0.07995, -0.005],
  AFp8: [0.04395, 0.0793, -0.0093],
  AFp8h: [0.03932, 0.08069, -0.00473],
  AFp9: [-0.03612, 0.07238, -0.04585],
  AFp9h: [-0.04329, 0.07586, -0.02824],
  AFpz: [0.00017, 0.08732, 0.01744],
  AFz: [0.00023, 0.08077, 0.03542],
  C1: [-0.03616, -0.00998, 0.08975],
  C1h: [-0.01828, -0.00943, 0.09736],
  C2: [0.03767, -0.00962, 0.08841],
  C2h: [0.01968, -0.0093, 0.09571],
  C3: [-0.06536, -0.01163, 0.06436],
  C3h: [-0.05158, -0.01075, 0.07803],
  C4: [0.06712, -0.0109, 0.06358],
  C4h: [0.05381, -0.01014, 0.07773],
  C5: [-0.08028, -0.01376, 0.02916],
  C5h: [-0.07529, -0.01264, 0.0479],
  C6: [0.08346, -0.01278, 0.02921],
  C6h: [0.07812, -0.01174, 0.04784],
  CCP1: [-0.03693, -0.02857, 0.09173],
  CCP1h: [-0.01835, -0.02832, 0.09822],
  CCP2: [0.03854, -0.02823, 0.09098],
  CCP2h: [0.02022, -0.02815, 0.09817],
  CCP3: [-0.06613, -0.0293, 0.0659],
  CCP3h: [-0.05293, -0.02891, 0.0803],
  CCP4: [0.06885, -0.02864, 0.06641],
  CCP4h: [0.05511, -0.02839, 0.08047],
  CCP5: [-0.08154, -0.03017, 0.03027],
  CCP5h: [-0.07641, -0.02973, 0.04922],
  CCP6: [0.08455, -0.02938, 0.03088],
  CCP6h: [0.07901, -0.02899, 0.04963],
  CCPz: [0.0004, -0.02816, 0.10127],
  CP1: [-0.03551, -0.04729, 0.09131],
  CP1h: [-0.01735, -0.04734, 0.09741],
  CP2: [0.03838, -0.04707, 0.09069],
  CP2h: [0.02068, -0.04723, 0.09807],
  CP3: [-0.06356, -0.04701, 0.06562],
  CP3h: [-0.05105, -0.04718, 0.08002],
  CP4: [0.06661, -0.04664, 0.06558],
  CP4h: [0.054, -0.04689, 0.08008],
  CP5: [-0.07959, -0.04655, 0.03095],
  CP5h: [-0.0733, -0.04679, 0.04911],
  CP6: [0.08332, -0.0461, 0.03121],
  CP6h: [0.07655, -0.04637, 0.04914],
  CPP1: [-0.03273, -0.06532, 0.08594],
  CPP1h: [-0.01582, -0.0656, 0.09116],
  CPP2: [0.03589, -0.06514, 0.08598],
  CPP2h: [0.01942, -0.0656, 0.09241],
  CPP3: [-0.05941, -0.06392, 0.06267],
  CPP3h: [-0.04691, -0.06469, 0.0753],
  CPP4: [0.06226, -0.06362, 0.06272],
  CPP4h: [0.05067, -0.06448, 0.07613],
  CPP5: [-0.07366, -0.06192, 0.03038],
  CPP5h: [-0.06812, -0.06297, 0.04725],
  CPP6: [0.07667, -0.06155, 0.03054],
  CPP6h: [0.0711, -0.06262, 0.04733],
  CPPz: [0.00037, -0.06575, 0.09406],
  CPz: [0.00039, -0.04732, 0.09943],
  Cz: [0.0004, -0.00917, 0.10024],
  F1: [-0.0275, 0.05693, 0.06034],
  F10: [0.07211, 0.04207, -0.05045],
  F10h: [0.0728, 0.04182, -0.03103],
  F1h: [-0.01338, 0.0579, 0.06433],
  F2: [0.02951, 0.0576, 0.05954],
  F2h: [0.01583, 0.05846, 0.06499],
  F3: [-0.05024, 0.05311, 0.04219],
  F3h: [-0.03998, 0.05526, 0.0526],
  F4: [0.05184, 0.0543, 0.04081],
  F4h: [0.04179, 0.05623, 0.0515],
  F5: [-0.06447, 0.04804, 0.01692],
  F5h: [-0.05849, 0.05067, 0.03019],
  F6: [0.06791, 0.04983, 0.01637],
  F6h: [0.06005, 0.05209, 0.02871],
  F7: [-0.07026, 0.04247, -0.01142],
  F7h: [-0.06856, 0.04528, 0.003],
  F8: [0.07304, 0.04442, -0.012],
  F8h: [0.07196, 0.04719, 0.00248],
  F9: [-0.0701, 0.04165, -0.04995],
  F9h: [-0.07151, 0.04112, -0.03085],
  FC1: [-0.03406, 0.02601, 0.07999],
  FC1h: [-0.01734, 0.02702, 0.08692],
  FC2: [0.03478, 0.02644, 0.07881],
  FC2h: [0.01842, 0.02727, 0.08644],
  FC3: [-0.06018, 0.02272, 0.05554],
  FC3h: [-0.04851, 0.02453, 0.06914],
  FC4: [0.06229, 0.02372, 0.05563],
  FC4h: [0.04955, 0.02524, 0.06843],
  FC5: [-0.07721, 0.01864, 0.02446],
  FC5h: [-0.07121, 0.02082, 0.04132],
  FC6: [0.07953, 0.01994, 0.02444],
  FC6h: [0.07322, 0.02201, 0.0413],
  FCC1: [-0.03575, 0.00831, 0.08546],
  FCC1h: [-0.01822, 0.00909, 0.09253],
  FCC2: [0.03607, 0.00865, 0.08383],
  FCC2h: [0.01879, 0.00925, 0.09156],
  FCC3: [-0.06416, 0.00583, 0.06088],
  FCC3h: [-0.05105, 0.00718, 0.07438],
  FCC4: [0.06516, 0.00662, 0.06005],
  FCC4h: [0.05189, 0.0078, 0.07351],
  FCC5: [-0.08013, 0.00259, 0.02731],
  FCC5h: [-0.07469, 0.0043, 0.04531],
  FCC6: [0.08154, 0.00366, 0.0272],
  FCC6h: [0.077, 0.00534, 0.04535],
  FCCz: [0.00039, 0.00951, 0.09556],
  FCz: [0.00038, 0.02739, 0.08867],
  FFC1: [-0.03065, 0.04242, 0.07104],
  FFC1h: [-0.01542, 0.04366, 0.07768],
  FFC2: [0.03265, 0.0431, 0.07079],
  FFC2h: [0.01759, 0.04405, 0.07779],
  FFC3: [-0.05594, 0.03872, 0.04979],
  FFC3h: [-0.04441, 0.04076, 0.06169],
  FFC4: [0.0575, 0.03985, 0.04881],
  FFC4h: [0.04585, 0.04162, 0.06065],
  FFC5: [-0.07151, 0.03393, 0.02099],
  FFC5h: [-0.06524, 0.03643, 0.03614],
  FFC6: [0.07425, 0.0355, 0.02038],
  FFC6h: [0.06713, 0.0378, 0.0353],
  FFCz: [0.00035, 0.04407, 0.07914],
  FFT10: [0.07992, 0.02894, -0.05091],
  FFT10h: [0.0801, 0.02851, -0.03134],
  FFT7: [-0.07661, 0.02865, -0.01151],
  FFT7h: [-0.0745, 0.0313, 0.00485],
  FFT8: [0.07903, 0.03034, -0.012],
  FFT8h: [0.07805, 0.03298, 0.00448],
  FFT9: [-0.07848, 0.02877, -0.05052],
  FFT9h: [-0.07907, 0.02808, -0.03125],
  FT10: [0.08411, 0.01436, -0.05054],
  FT10h: [0.08337, 0.01355, -0.03075],
  FT7: [-0.08077, 0.01412, -0.01113],
  FT7h: [-0.08011, 0.01639, 0.00685],
  FT8: [0.08182, 0.01542, -0.01133],
  FT8h: [0.08158, 0.01768, 0.00656],
  FT9: [-0.08408, 0.01457, -0.05043],
  FT9h: [-0.08296, 0.01332, -0.03081],
  FTT10: [0.08539, -0.00095, -0.04952],
  FTT10h: [0.08412, -0.00181, -0.02964],
  FTT7: [-0.08267, -0.00094, -0.01028],
  FTT7h: [-0.08235, 0.00083, 0.00858],
  FTT8: [0.08317, 0.00018, -0.01036],
  FTT8h: [0.08389, 0.00195, 0.0085],
  FTT9: [-0.08736, -0.00051, -0.04984],
  FTT9h: [-0.08413, -0.00185, -0.02979],
  Fp1: [-0.02944, 0.08392, -0.00699],
  Fp1h: [-0.01481, 0.08724, -0.00448],
  Fp2: [0.02987, 0.0849, -0.00708],
  Fp2h: [0.01516, 0.08809, -0.00455],
  Fpz: [0.00011, 0.08825, -0.00171],
  Fz: [0.00031, 0.05851, 0.06646],
  I1: [-0.02982, -0.11457, -0.02922],
  I1h: [-0.01516, -0.11824, -0.02605],
  I2: [0.02974, -0.11426, -0.02926],
  I2h: [0.01513, -0.11815, -0.02608],
  Iz: [0.0, -0.11857, -0.02308],
  M1: [-0.08608, -0.04499, -0.06799],
  M2: [0.08579, -0.04501, -0.06803],
  O1: [-0.02941, -0.11245, 0.00884],
  O1h: [-0.01481, -0.1151, 0.01183],
  O2: [0.02984, -0.11216, 0.0088],
  O2h: [0.01515, -0.11519, 0.01183],
  OI1: [-0.02939, -0.11451, -0.01002],
  OI1h: [-0.01485, -0.11799, -0.00692],
  OI2: [0.02955, -0.11364, -0.01005],
  OI2h: [0.01509, -0.11802, -0.00693],
  OIz: [5e-5, -0.11934, -0.00394],
  Oz: [0.00011, -0.11489, 0.01466],
  P1: [-0.02862, -0.08052, 0.07544],
  P10: [0.07389, -0.07439, -0.04122],
  P10h: [0.07328, -0.07508, -0.02158],
  P1h: [-0.01396, -0.081, 0.081],
  P2: [0.03192, -0.08049, 0.07672],
  P2h: [0.0173, -0.08098, 0.08164],
  P3: [-0.05301, -0.07879, 0.05594],
  P3h: [-0.04167, -0.07975, 0.06671],
  P4: [0.05567, -0.07856, 0.05656],
  P4h: [0.04475, -0.07961, 0.06766],
  P5: [-0.06727, -0.07629, 0.02838],
  P5h: [-0.06173, -0.07762, 0.04303],
  P6: [0.06789, -0.0759, 0.02809],
  P6h: [0.06363, -0.0773, 0.04312],
  P7: [-0.07243, -0.07345, -0.00249],
  P7h: [-0.07011, -0.07487, 0.013],
  P8: [0.07306, -0.07307, -0.00254],
  P8h: [0.0721, -0.0745, 0.01303],
  P9: [-0.07301, -0.07377, -0.041],
  P9h: [-0.07218, -0.07463, -0.02154],
  PO1: [-0.01897, -0.10177, 0.04654],
  PO10: [0.05499, -0.09809, -0.03554],
  PO10h: [0.05586, -0.09989, -0.01621],
  PO1h: [-0.0095, -0.10206, 0.04942],
  PO2: [0.01988, -0.10179, 0.04639],
  PO2h: [0.01024, -0.10203, 0.04894],
  PO3: [-0.03651, -0.10085, 0.03717],
  PO3h: [-0.02801, -0.10136, 0.04238],
  PO4: [0.03678, -0.10085, 0.0364],
  PO4h: [0.02865, -0.10139, 0.04214],
  PO5: [-0.04842, -0.09934, 0.0216],
  PO5h: [-0.04334, -0.10016, 0.03001],
  PO6: [0.04982, -0.09945, 0.02173],
  PO6h: [0.04422, -0.10022, 0.02981],
  PO7: [-0.05484, -0.09753, 0.00279],
  PO7h: [-0.05193, -0.09844, 0.0123],
  PO8: [0.05567, -0.09763, 0.00273],
  PO8h: [0.05284, -0.09854, 0.01225],
  PO9: [-0.05491, -0.09804, -0.03547],
  PO9h: [-0.05478, -0.09898, -0.01619],
  POO1: [-0.01366, -0.10927, 0.03286],
  POO10: [0.04318, -0.10744, -0.03246],
  POO10h: [0.04389, -0.10913, -0.01317],
  POO1h: [-0.00692, -0.10926, 0.03271],
  POO2: [0.01365, -0.10911, 0.03094],
  POO2h: [0.0068, -0.10916, 0.03158],
  POO3: [-0.02598, -0.10862, 0.02654],
  POO3h: [-0.01986, -0.10894, 0.02976],
  POO4: [0.02666, -0.10867, 0.02641],
  POO4h: [0.02029, -0.10891, 0.02894],
  POO5: [-0.03623, -0.10772, 0.01775],
  POO5h: [-0.03195, -0.10825, 0.02305],
  POO6: [0.0377, -0.10784, 0.01807],
  POO6h: [0.03218, -0.10825, 0.02226],
  POO7: [-0.04298, -0.10649, 0.00577],
  POO7h: [-0.04012, -0.10713, 0.01206],
  POO8: [0.04367, -0.1066, 0.00573],
  POO8h: [0.0411, -0.10725, 0.01214],
  POO9: [-0.04313, -0.10752, -0.03239],
  POO9h: [-0.04286, -0.10807, -0.01315],
  POOz: [0.00017, -0.10928, 0.03279],
  POz: [0.00022, -0.10218, 0.05061],
  PPO1: [-0.02465, -0.09229, 0.06208],
  PPO10: [0.06504, -0.08672, -0.03845],
  PPO10h: [0.06501, -0.08781, -0.01895],
  PPO1h: [-0.01205, -0.09261, 0.06551],
  PPO2: [0.02644, -0.0923, 0.0632],
  PPO2h: [0.01392, -0.09269, 0.06696],
  PPO3: [-0.04616, -0.09089, 0.04745],
  PPO3h: [-0.03589, -0.09167, 0.0555],
  PPO4: [0.04714, -0.09071, 0.04768],
  PPO4h: [0.0378, -0.09163, 0.05673],
  PPO5: [-0.05871, -0.0887, 0.02519],
  PPO5h: [-0.05401, -0.0899, 0.03733],
  PPO6: [0.06081, -0.0885, 0.02566],
  PPO6h: [0.05461, -0.08964, 0.03703],
  PPO7: [-0.06458, -0.08622, 3e-5],
  PPO7h: [-0.06296, -0.0875, 0.01295],
  PPO8: [0.06515, -0.08594, -1e-5],
  PPO8h: [0.06311, -0.08723, 0.01286],
  PPO9: [-0.06457, -0.08643, -0.03832],
  PPO9h: [-0.0646, -0.08766, -0.01901],
  PPOz: [0.00027, -0.09276, 0.06734],
  Pz: [0.00032, -0.08111, 0.08261],
  T10: [0.08556, -0.01636, -0.04827],
  T10h: [0.0861, -0.01709, -0.02876],
  T3: [-0.08416, -0.01602, -0.00935],
  T4: [0.08508, -0.01502, -0.00949],
  T5: [-0.07243, -0.07345, -0.00249],
  T6: [0.07306, -0.07307, -0.00254],
  T7: [-0.08416, -0.01602, -0.00935],
  T7h: [-0.08295, -0.01488, 0.01001],
  T8: [0.08508, -0.01502, -0.00949],
  T8h: [0.08514, -0.01391, 0.00989],
  T9: [-0.08589, -0.01583, -0.04828],
  T9h: [-0.08513, -0.01706, -0.02873],
  TP10: [0.08616, -0.04704, -0.04587],
  TP10h: [0.08544, -0.04722, -0.02618],
  TP7: [-0.08483, -0.04602, -0.00706],
  TP7h: [-0.0827, -0.0463, 0.01197],
  TP8: [0.08555, -0.04555, -0.00713],
  TP8h: [0.0852, -0.04581, 0.0121],
  TP9: [-0.08562, -0.04651, -0.04571],
  TP9h: [-0.08481, -0.04725, -0.02622],
  TPP10: [0.08156, -0.06122, -0.0438],
  TPP10h: [0.0789, -0.06096, -0.0238],
  TPP7: [-0.0786, -0.05972, -0.00476],
  TPP7h: [-0.07668, -0.06083, 0.01288],
  TPP8: [0.07932, -0.0593, -0.00484],
  TPP8h: [0.07852, -0.06043, 0.0129],
  TPP9: [-0.08072, -0.06065, -0.04359],
  TPP9h: [-0.07816, -0.06076, -0.02382],
  TTP10: [0.08676, -0.03173, -0.04725],
  TTP10h: [0.08862, -0.03227, -0.028],
  TTP7: [-0.08593, -0.03109, -0.00847],
  TTP7h: [-0.08557, -0.03063, 0.01115],
  TTP8: [0.086, -0.03028, -0.00843],
  TTP8h: [0.086, -0.02982, 0.01125],
  TTP9: [-0.08663, -0.03124, -0.04718],
  TTP9h: [-0.08697, -0.03222, -0.02785],
};

/** Legacy 10-20 labels mapped onto the modern 10-10 names present in STANDARD_1005. */
const ALIASES: Readonly<Record<string, string>> = {
  T3: "T7",
  T4: "T8",
  T5: "P7",
  T6: "P8",
};

/** Uppercased label -> Vec3 (including alias keys) for case-insensitive lookup. */
const INDEX: ReadonlyMap<string, Vec3> = (() => {
  const m = new Map<string, Vec3>();
  for (const [label, xyz] of Object.entries(STANDARD_1005)) m.set(label.toUpperCase(), xyz);
  for (const [legacy, modern] of Object.entries(ALIASES)) {
    const xyz = m.get(modern.toUpperCase());
    if (xyz) m.set(legacy.toUpperCase(), xyz);
  }
  return m;
})();

/** Standard position for a channel label (case-insensitive, legacy-aliased), or null. */
export function lookupStandardPosition(label: string): Vec3 | null {
  return INDEX.get(label.trim().toUpperCase()) ?? null;
}

function upperIndex(table: Readonly<Record<string, Vec3>>): ReadonlyMap<string, Vec3> {
  const m = new Map<string, Vec3>();
  for (const [label, xyz] of Object.entries(table)) m.set(label.toUpperCase(), xyz);
  return m;
}

// Canonical named-net montages (#855), keyed uppercase. Consulted only when the
// standard 10-xx set fails to resolve, so a dataset that ships no electrodes.tsv
// but uses a recognizable EGI/BioSemi cap still gets an (estimated) topomap.
const EGI_129 = upperIndex(GSN_HYDROCEL_129);
const EGI_257 = upperIndex(GSN_HYDROCEL_257);
const BIOSEMI128 = upperIndex(BIOSEMI_128);
const BIOSEMI256 = upperIndex(BIOSEMI_256);

/**
 * Pick the canonical named-net montage matching a label set, or null when the
 * labels look like neither an EGI geodesic net nor a BioSemi cap.
 *
 * The two label namespaces overlap on `E*` (BioSemi-256 banks run A..H, so it
 * also has E1..E32), so we disambiguate on the BioSemi A-bank: every BioSemi
 * cap starts at A1, while EGI geodesic nets are pure E-numbering (E1.., + Cz).
 * Net size is read from the highest bank/number seen, since a dataset normally
 * carries every electrode in its cap. The result is always an *estimated*
 * layout (the caller flags it), never measured positions.
 */
function namedNetIndex(upperLabels: string[]): ReadonlyMap<string, Vec3> | null {
  const hasABank = upperLabels.some((l) => /^A\d{1,2}$/.test(l));
  if (hasABank) {
    const banks = new Set<string>();
    let count = 0;
    for (const l of upperLabels) {
      const m = /^([A-H])\d{1,2}$/.exec(l);
      if (m) {
        banks.add(m[1]);
        count++;
      }
    }
    if (count < 3) return null;
    const maxBank = [...banks].sort().pop() as string;
    return maxBank <= "D" ? BIOSEMI128 : BIOSEMI256;
  }
  let eCount = 0;
  let eMax = 0;
  for (const l of upperLabels) {
    const m = /^E(\d{1,3})$/.exec(l);
    if (m) {
      eCount++;
      eMax = Math.max(eMax, Number(m[1]));
    }
  }
  if (eCount >= 3) return eMax <= 129 ? EGI_129 : EGI_257;
  return null;
}

/**
 * Build a {label: [x,y,z]} map (keyed by the caller's original label spelling) for the
 * channel labels that resolve against the standard montage. Labels that do not resolve
 * are simply omitted, so a recording with no standard labels yields an empty map and
 * the caller draws no topomap.
 */
export function standardMontageFor(labels: Iterable<string>): Record<string, Vec3> {
  const arr = [...labels];

  // A recognizable EGI/BioSemi cap is authoritative for its own labels, so it
  // is tried first: several bank labels (C1, F1, A1/A2 ear refs, ...) also
  // exist in the 10-05 set but sit in different places on a geodesic/BioSemi
  // cap, so a partial standard match must not win over the real net. This is
  // what lets EGI `E1..E128` datasets that ship no electrodes.tsv (e.g. HBN
  // mirrors) draw an estimated topomap; the caller flags it estimated (#855).
  const net = namedNetIndex(arr.map((l) => l.trim().toUpperCase()));
  if (net) {
    const netOut: Record<string, Vec3> = {};
    for (const label of arr) {
      const pos = net.get(label.trim().toUpperCase());
      if (pos) netOut[label] = pos;
    }
    if (Object.keys(netOut).length >= 3) return netOut;
  }

  const out: Record<string, Vec3> = {};
  for (const label of arr) {
    const pos = lookupStandardPosition(label);
    if (pos) out[label] = pos;
  }
  return out;
}

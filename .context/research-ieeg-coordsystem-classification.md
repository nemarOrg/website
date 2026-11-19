# iEEG electrode coordinate metadata: classification of public datasets

Survey date: 2026-11-19.
Scope: all 167 public datasets of modality ieeg in the catalog (157 with at least one recording).
Method: read-only public requests.
For each dataset the latest version was read; up to five subjects spread across the subject list were sampled, and for those subjects up to three sessions, reading every `*_coordsystem.json` and `*_electrodes.tsv` found (including `space-` labeled variants).
Every dataset was read; one (on005691) has no latest version in the catalog and could not be read.
Each dataset gets exactly one class by this precedence when files within a dataset disagree: B1, B2, E, A3, C, D, A1, A2, F.
Mixed datasets are flagged in the evidence column.
Because only a sample of subjects was read, a dataset classed D or C may contain subjects of another class that were not sampled.
Valid frame identifiers were checked case-sensitively against the BIDS list, so `MNI152NLin6Asym` (lowercase s) counts as invalid.

## Counts by class

| Class | Meaning | Datasets | Recordings |
|---|---|---:|---:|
| A1 | No coordinates, source released none (explained) | 42 | 10924 |
| A2 | No coordinates, undocumented | 2 | 24 |
| A3 | Coordinates exist elsewhere in the dataset, not in x/y/z | 9 | 6808 |
| B1 | Frame Other, template family and exact variant stated | 1 | 111 |
| B2 | Frame Other, MNI/Talairach named or suggested, variant not stated | 17 | 467 |
| C | Native or subject space (ACPC, ScanRAS, tkrRAS, voxel, other native) | 28 | 8489 |
| D | Template frame correctly declared with units | 33 | 5892 |
| E | Units, magnitude or identifier problem | 10 | 613 |
| F | No coordsystem file, no electrodes file, or nothing readable | 25 | 2621 |
| Total | | 167 | 35949 |

Recordings are the catalog `recording_count` per dataset (0 where the catalog reports none).
Twelve datasets report 0 or no recordings (nm000350, nm000363, nm000387, nm000389, nm000390, nm000411, nm000461, nm000464, on002799, on005083, on006253, on008610); those with coordinate files were still classified by their content.

## Per-dataset classification

| Dataset | Class | Frame | Units | Recordings | Evidence |
|---|---|---|---|---:|---|
| nm000182 | A1 | Other | mm | 257 | x/y/z all n/a; 'Patient-specific electrode coordinates were not released with the segmented dataset. Anatomical labels and SOZ flags are preserved' |
| nm000183 | A1 | Other | mm | 632 | x/y/z all n/a; 'Patient-specific electrode coordinates were not released with the segmented dataset. Anatomical labels and SOZ flags are preserved' |
| nm000241 | A2 | Other | n/a | 18 | x/y/z all n/a; no explanation |
| nm000251 | A2 | Other | n/a | 6 | x/y/z all n/a; no explanation |
| nm000253 | E | Other | n/a | 26 | frame Other, units n/a; numeric x/y/z (57 to 191) as reported in depth-wm.csv, axes labelled L, I, P; source 'does NOT publish the coordinate units, origin, or the transform' |
| nm000276 | A1 | Other | n/a | 50 | x/y/z all n/a; 'Electrode coordinates are not available; the public SWEC release is anonymized and does not disclose electrode localization. All c' |
| nm000350 | A3 | Other | n/a | 0 | x/y/z n/a; source NWB x/y/z kept in electrodes.tsv columns nwb_x, nwb_y, nwb_z, frame and units undocumented in source; catalog recording_count 0 |
| nm000352 | B1 | Other | mm | 111 | Other, mm; 'Talairach coordinates obtained via the source-documented LOC package'; Talairach has no variants but mm 'assumed ... not confirmed' |
| nm000353 | A1 | Other | n/a | 300 | x/y/z all n/a; 'No electrode positions are available. The source does not record which contact, electrode or patient each signal came from, so all' |
| nm000354 | D | MNI152NLin2009cAsym | mm | 20 | valid identifier; channels_MNI as supplied by source; mm assumed by MNI convention. Source: 'channels_MNI: MNI coordinates of th |
| nm000355 | C | ACPC | mm | 1 | ACPC, mm; extra columns x_mni_frv, y_mni_frv, z_mni_frv hold MNI values with no declared variant |
| nm000356 | B2 | Other | mm | 29 | Other, mm; 'MNI coordinates as provided by the authors ... exact MNI template variant is not stated' |
| nm000357 | B2 | Other | mm | 29 | Other, mm; 'MNI152 template space as provided ... exact MNI152 template variant ... is not stated'; paper plots on MNI152NLin2009cAsym |
| nm000358 | B2 | Other | mm | 55 | Other, mm; 'warped into MNI space ... The exact MNI template is not stated' |
| nm000359 | A1 | Other | n/a | 7500 | x/y/z all n/a; 'No electrode positions are available. The source does not record which contact, electrode or patient each signal came from, so all' |
| nm000360 | D | MNI152Lin, Other | mm, n/a | 25 | MNI152Lin mm for 4 of 5 sampled subjects; sub-13 Other n/a (no coordinates, source archive lacks them) |
| nm000361 | D | Talairach | mm | 71 | valid identifier; Talairach coordinates as stated by the source readme_HighSamplingRate.txt. |
| nm000362 | D | MNI152NLin2009aSym | mm | 535 | valid identifier; ICBM 2009a nonlinear symmetric template (1x1x1 mm), as stated by the source readme. |
| nm000363 | F | none | none | 0 | no coordsystem and no electrodes file in sampled subjects (catalog recording_count 0) |
| nm000364 | A1 | Other | n/a | 8 | x/y/z all n/a; 'The source (Figshare 10.6084/m9.figshare.32189838.v1) provides no electrode coordinates and no imaging. x, y and z are n/a. Contac' |
| nm000365 | A1 | Other | n/a | 67 | x/y/z all n/a; 'No electrode coordinates or anatomical labels are included in the Du-IN release (Hugging Face liulab-repository/Du-IN); x, y, z in' |
| nm000367 | B2 | Other | mm | 16 | Other, mm; 'aligned to the CIT168 template brain in MNI152 coordinates ... specific BIDS template label is not asserted' |
| nm000368 | B2 | Other | mm | 43 | Other, mm; 'CITI168 Atlas Brain in MNI152 coordinates ... for visualization'; no space description in NWB |
| nm000369 | B2 | Other | mm | 2 | Other, mm; source 'does not name the coordinate system'; atlas look-ups 'suggesting template (MNI) space, which is not verified' |
| nm000370 | A3 | Other | n/a | 3 | x/y/z n/a; probe geometry in micrometers in electrodes.tsv columns probe_x_um, probe_y_um |
| nm000371 | C | ACPC | mm | 8 | ACPC; native space |
| nm000372 | C | Other | mm | 2 | Other, mm; 'FreeSurfer surface RAS (tkrRAS) of the patient's T1' |
| nm000373 | E | MNI152NLin6Asym | n/a | 30 | MNI152NLin6Asym (note: BIDS spelling is MNI152NLin6ASym), units n/a; values are 2 mm voxel indices (x 7-83), not mm |
| nm000374 | A1 | Other | n/a | 22 | x/y/z all n/a; 'No electrode coordinates are included in the source release (Zenodo 14885382). The paper localized contacts by co-registering post' |
| nm000375 | A1 | Other | n/a | 16 | x/y/z all n/a; 'No electrode coordinates are included in the Dryad release; electrodes.tsv lists the contacts named in the bipolar channel labels ' |
| nm000376 | D | IXI549Space | mm | 9 | valid identifier; MNI coordinates from channelInfo.MNI_x/y/z of the release, one point per bipolar channel ('Bipolar iEEG signal |
| nm000377 | B2 | Other | mm | 8 | Other, mm; positions 'warped to a template'; 'The template is not named' (MNI not stated) |
| nm000379 | D | IXI549Space | mm | 31 | valid identifier; Authors' MNI coordinates (data/localization/<S>/<S>_mni.csv): T1 MRIs normalized to MNI space with SPM12 (affi |
| nm000380 | C | Other | mm, n/a | 45 | Other, mm; 'patient-specific space ... exact space not stated'; one participant has no coordinates (n/a) |
| nm000383 | A3 | Other | n/a | 30 | x/y/z n/a; per-electrode distances to orbital sulci (lat_coor, med_coor, olf_coor, trans_coor, mid_coor) in channels.tsv |
| nm000386 | A1 | Other | n/a | 41 | x/y/z all n/a; 'No electrode coordinates are released; electrodes.tsv lists the SEEG contact names with x/y/z = n/a. Coordinates can be derived fr' |
| nm000387 | F | none | none | 0 | no coordsystem and no electrodes file in sampled subjects (catalog recording_count 0) |
| nm000389 | F | none | none | 0 | no coordsystem and no electrodes file in sampled subjects (catalog recording_count 0) |
| nm000390 | F | none | none | 0 | no coordsystem and no electrodes file in sampled subjects (catalog recording_count 0) |
| nm000394 | A1 | Other | n/a | 34 | x/y/z all n/a; 'Electrode coordinates were not released by the source; only contact names are known.' |
| nm000395 | A1 | Other | n/a | 8 | x/y/z all n/a; 'No electrode coordinates in the release. Names are the amplifier inputs of the recording (Amp<k>-<n>); positions would need the CT' |
| nm000396 | A1 | Other | n/a | 13 | x/y/z all n/a; 'No electrode coordinates are included in the source release (Zenodo 16954184). The paper localized electrodes on clinical neuroima' |
| nm000397 | A1 | Other | n/a | 46 | x/y/z all n/a; 'No electrode coordinates, contact names or anatomical labels are released (channels are Neuroport amplifier inputs chan1..chan128)' |
| nm000398 | A1 | Other | n/a | 23 | x/y/z all n/a; 'No electrode coordinates or labels are released; positions are shown only as an image in README_for_SubA_Sleep1.pdf (sourcedata). ' |
| nm000399 | D | MNI152NLin2009bAsym | mm | 26 | valid identifier; MNI ICBM152 NLIN 2009b: the article normalised pre/post-operative images into this space with Lead-DBS; coordi |
| nm000400 | A1 | Other | n/a | 30 | x/y/z all n/a; 'No electrode coordinates are released (NWB electrodes x/y/z are NaN); x, y, z are n/a. Anatomical labels by the authors are in loc' |
| nm000401 | A1 | Other | n/a | 17 | x/y/z all n/a; 'No electrode coordinates are released (channel numbers only); recordings are from the subthalamic nucleus per the article. x, y, z' |
| nm000402 | C | Other | n/a, mm | 78 | Other; mix of 'Voxel indices' (n/a units) and 'Patient-native space' mm; surface-RAS and voxel columns also present |
| nm000403 | A1 | Other | n/a | 56 | x/y/z all n/a; 'No coordinates are released: the per-participant Talairach/MNI coordinate .txt files mentioned in the README are not in the Dryad ' |
| nm000404 | B2 | Other | mm | 25 | Other, mm; 'MNI coordinates of each bipolar channel ... Template variant not named' |
| nm000405 | B2 | Other | m | 73 | Other, m; 'MNI space as labelled by the authors (space-mni); the exact template is not stated'; Lead-DBS |
| nm000406 | A1 | Other | n/a | 830 | x/y/z all n/a; 'No electrode coordinates are included in the source release (Zenodo 7352058); x, y, z are n/a. Each recording is a microelectrode ' |
| nm000408 | A1 | Other | n/a | 110 | x/y/z all n/a; 'No electrode coordinates in the release (the paper shows a reconstruction image only). Names are the WIMAGINE channel labels as re' |
| nm000409 | A1 | Other | n/a | 24 | x/y/z all n/a; 'The release has no channel names; channels are numbered in the column order of the release. A Talairach-space cortical model with ' |
| nm000410 | A1 | Other | n/a | 79 | x/y/z all n/a; 'The release gives no contact coordinates, only the anatomical region of each bipolar channel; x/y/z are n/a. One row per bipolar c' |
| nm000411 | A1 | Other | n/a | 0 | x/y/z all n/a; 'No electrode coordinates in the release (the BrainQuake electrode module derives them from the post-implant CT, which is not redis'; catalog recording_count 0 |
| nm000412 | A1 | Other | n/a | 24 | x/y/z all n/a; 'No electrode coordinates are included in the source release (Zenodo 4761390). The paper localised electrodes by co-registering pos' |
| nm000413 | A1 | Other | n/a | 190 | x/y/z all n/a; 'No electrode coordinates are included in the source release (Zenodo 17272689); x, y, z are n/a.' |
| nm000414 | A1 | Other | n/a | 41 | x/y/z all n/a; 'No contact coordinates are released; the record includes only an electrode diagram (sourcedata/.../packages/Cartoon Map.pdf). x/y/' |
| nm000424 | A1 | Other | n/a | 24 | x/y/z all n/a; 'No microelectrode coordinates are released; tracks listed with x, y, z = n/a.' |
| nm000429 | A1 | Other | n/a | 16 | x/y/z all n/a; 'No electrode coordinates or recording depths are released; microelectrodes were in the subthalamic nucleus (article). x, y, z = n/' |
| nm000430 | B2 | Other | mm | 8 | Other, mm; 'MNI coordinates (mm) ... the MNI template is not stated' |
| nm000432 | A3 | Other | n/a | 32 | x/y/z n/a; STN target coordinates and track depths (frame coordinates) in sourcedata docs/recordingdetails.txt |
| nm000433 | A1 | Other | n/a | 82 | x/y/z all n/a; 'No electrode coordinates or imaging are released; contacts are listed with x, y, z = n/a and the stated target.' |
| nm000434 | A1 | Other | n/a | 88 | x/y/z all n/a; 'No contact coordinates or imaging are released; contacts listed with x, y, z = n/a.' |
| nm000435 | B2 | Other | mm | 13 | Other, mm; 'MNI space coordinates of the authors (template not specified in the release)' |
| nm000436 | C | Other | mm | 84 | Other, mm; target-relative offsets (Ben-gun x 0, y +2/0/-2, z depth); 'Not MNI, not Talairach, not a scanner/ACPC frame' |
| nm000437 | A1 | Other | n/a | 15 | x/y/z all n/a; 'No electrode coordinates are included in the source release (Zenodo 17426506); the channels are bipolar feature channels whose con' |
| nm000443 | A1 | Other | n/a | 68 | x/y/z all n/a; 'No contact coordinates are released. Contacts are listed with x, y, z = n/a under the release names L1-L8/R1-R8 (level 1 most infe' |
| nm000446 | A1 | Other | n/a | 44 | x/y/z all n/a; 'No contact coordinates are released (Wiest et al. 2023 localised leads with Lead-DBS, but the coordinates are not shared). Electro' |
| nm000452 | A1 | Other | n/a | 1 | x/y/z all n/a; 'No contact coordinates and no column-to-contact mapping were released; electrodes.tsv lists the 225 data columns with n/a coordina' |
| nm000453 | A3 | Other | mm | 6675 | x/y/z n/a; Ben-gun position and recording depth relative to MRI-planned target only, no coordinates released |
| nm000454 | D | MNI152NLin2009cAsym | mm | 1261 | valid identifier; x/y/z from deposit derivatives/sub-*/recon/ieeg_recon/module3/MNI/sub-*_ses-research3T_space-MNI152NLin2009cAs |
| nm000455 | E | Other | n/a | 32 | frame Other, units n/a; positive values (about 10 to 200) are voxel indices of the template image, not mm; README calls them '3d MNI coordinates', article names 'Colin 22 brain template' (variant stated, transform to mm not given) |
| nm000456 | F | none | none | 69 | no coordsystem and no electrodes file in sampled subjects |
| nm000460 | A1 | Other | n/a | 7 | x/y/z all n/a; 'No electrode coordinates were released (the MRI/CT images are available only on request from the Data Access Committee of the Neth' |
| nm000461 | F | none | none | 0 | no coordsystem and no electrodes file in sampled subjects (catalog recording_count 0) |
| nm000462 | E | Other | n/a | 4 | frame Other, units n/a; numeric x/y/z (up to 363) copied from .pkl files; 'does not state the coordinate space or units' |
| nm000463 | E | Other | n/a | 155 | frame Other, units n/a; numeric x/y/z copied from origCoords; 'does not state the coordinate space or units' |
| nm000464 | F | none | none | 0 | no coordsystem and no electrodes file in sampled subjects (catalog recording_count 0) |
| nm000465 | A1 | Other | n/a | 47 | x/y/z all n/a; 'No coordinates are released. Labels per TDT channel from the authors' getchans.m (main task) / getlocchans.m (localizer) in Zenodo' |
| nm000469 | B2 | Other | mm | 2 | Other, mm; 'field name suggests Talairach space; the release does not state the template or the localisation method'; units assumed |
| nm000471 | A1 | Other | n/a | 22 | x/y/z all n/a; 'No electrode coordinates or anatomical labels are released for the iEEG channels (anonymised names channel01..N; the file names sa' |
| nm000472 | A1 | Other | n/a | 1 | x/y/z all n/a; 'No electrode coordinates are released as numbers. The Zenodo record contains a post-implantation MRI (DICOM T1/T2 with the electro' |
| nm000473 | B2 | ACPC, Other | mm | 10 | Other, mm for MNI file ('MNI template version is not stated'); main sidecars are ACPC mm; ACPC positions of all contacts also in sourcedata |
| nm000475 | D | Talairach | mm | 9 | valid identifier; Talairach coordinates of the intracerebral contacts as given in the release file P3_TAL_coordinates.xlsx (READ |
| nm000476 | A1 | Other | n/a | 14 | x/y/z all n/a; 'No electrode coordinates are released; one basal-ganglia DBS lead (STN or GPi) and one prefrontal electrode (FPC or OFC) per subje' |
| nm000477 | A1 | Other | n/a | 67 | x/y/z all n/a; 'No coordinates are released. Target structure (substantia nigra or globus pallidus) from the release folder; hemisphere, track and' |
| nm000480 | B2 | Other | mm | 11 | Other, mm; 'release does not state which of the two spaces (native or MNI) chanpos is in' |
| nm000481 | B2 | Other | mm | 14 | Other, mm; 'MNI coordinates ... as listed in Table 3 of the article; template version is not stated' |
| nm000482 | A3 | Other | mm | 14 | x/y/z n/a; per-contact sulcal distances (lat_coor, med_coor, mid_coor, olf_coor, trans_coor, mm) in electrodes table |
| nm000483 | C | Other | mm | 5 | Other, mm; 'Brainstorm subject coordinate system (SCS) ... Native space' |
| nm000484 | A1 | Other | n/a | 1 | x/y/z all n/a; 'No electrode names, positions or types are released; one entry per matrix row with x, y, z = n/a.' |
| nm000485 | B2 | Other, Talairach | mm | 111 | Other, mm for MNI file ('template version is not stated'); parallel Talairach file declared Talairach mm |
| nm000487 | D | Talairach | mm | 140 | valid identifier; 3D Talairach coordinates of each intracerebral contact as stored by the authors in the Letswave header (chanlo |
| nm000501 | C | ACPC | mm | 20 | ACPC; native space |
| nm000513 | A1 | Other | n/a | 9 | x/y/z all n/a; 'No contact coordinates are released; contacts listed from the bipolar channel labels.' |
| nm000537 | A3 | Other | n/a | 46 | x/y/z n/a; Coordinates.mat files with unstated space kept in sourcedata |
| on001785 | C | UNPARSEABLE | none | 54 | frame 'postimplant' (not a valid identifier), mm; coordsystem JSON has a trailing comma and does not parse |
| on002799 | E | MNI152NLin6Asym | mm | 0 | MNI152NLin6Asym, mm: spelling is not a valid identifier (BIDS spells MNI152NLin6ASym); no description; catalog recording_count 0 |
| on003029 | F | none | none | 106 | no coordsystem and no electrodes file in sampled subjects |
| on003078 | F | none | none | 72 | no coordsystem and no electrodes file in sampled subjects |
| on003374 | B2 | Other | mm | 18 | Other, mm; 'MNI152, standard MNI space' (MNI152 family, variant not stated) |
| on003498 | F | none | none | 385 | no coordsystem and no electrodes file in sampled subjects |
| on003688 | C | ACPC | mm | 107 | ACPC; native space |
| on003708 | D | MNI152NLin6Sym | mm | 1 | valid identifier; Also known as symmetric ICBM 6th generation (non-linear coregistration). Used by SPM99 - SPM8. |
| on003844 | E | Other | mm | 38 | frame Other, mm, 'origin ... between the ears ... RAS'; every sampled electrode x/y/z is exactly 0.0 |
| on003848 | C | Other | mm | 22 | Other/ACPC native; The origin of the coordinate system is between the ears and the axis are in the RAS direction. The scaling is  |
| on003876 | F | none | none | 54 | no coordsystem and no electrodes file in sampled subjects |
| on004080 | D | fsaverage | mm | 117 | valid identifier; The fsaverage is a dual template providing both volumetric and surface coordinates references. The volumetric  |
| on004100 | E | fsaverage | m | 319 | fsaverage declared in units m but magnitudes up to 93.6 (mm scale) |
| on004127 | F | none | none | 73 | no coordsystem and no electrodes file in sampled subjects |
| on004194 | C | ACPC, Other | mm | 209 | ACPC (mm) and Other ('T1') sidecars mixed across subjects |
| on004370 | F | none | none | 15 | no coordsystem file in sampled subjects; electrodes.tsv has numeric x/y/z |
| on004457 | C | ACPC, Other | mm | 5 | Other/ACPC native; ACPC using VISTASOFT software repository |
| on004473 | C | ACPC, ScanRAS | m | 8 | ACPC/ScanRAS; native space |
| on004551 | F | none | none | 125 | no coordsystem file in sampled subjects; electrodes.tsv has numeric x/y/z |
| on004624 | F | none | none | 614 | no coordsystem and no electrodes file in sampled subjects |
| on004642 | F | none | none | 10 | no coordsystem and no electrodes file in sampled subjects |
| on004696 | C | Other, ACPC | mm | 8 | Other/ACPC native; Native space. The coordinate frame of the scanner at data acquisition of the T1w volume |
| on004703 | F | none | none | 11 | no coordsystem and no electrodes file in sampled subjects |
| on004752 | F | none | none | 136 | no coordsystem file in sampled subjects; electrodes.tsv has numeric x/y/z |
| on004774 | C | Other | mm | 14 | Other/ACPC native; 0 0 0 close to the AC, X axis pointing right, Y axis pointing forward, Z axis pointing upwards |
| on004789 | D | MNI152NLin6ASym | mm | 983 | valid identifier |
| on004809 | D | MNI152NLin6ASym | mm | 889 | valid identifier; sampled x range -166 to 81 (outside brain extent for some contacts) |
| on004819 | A3 | none | none | 8 | x/y/z n/a; probe geometry in microns in columns rel_xlocation_microns, rel_ylocation_microns; no coordsystem file |
| on004859 | D | fsaverage | mm | 9 | valid identifier |
| on004865 | D | Talairach | mm | 172 | valid identifier |
| on004977 | C | ACPC | mm | 6 | ACPC; native space |
| on004993 | C | ACPC | mm | 6 | ACPC; native space |
| on005007 | F | none | none | 42 | no coordsystem file in sampled subjects; electrodes.tsv has numeric x/y/z |
| on005059 | D | MNI152NLin6ASym | mm | 282 | valid identifier |
| on005083 | C | Other | mm | 0 | Other/ACPC native; Coordinates from native post-op CT image space. Not aligned to any other imaging or atlas.; catalog recording_count 0 |
| on005169 | C | ScanRAS | mm | 112 | ScanRAS; native space |
| on005398 | D | MNI152Lin | mm | 185 | valid identifier |
| on005411 | D | MNI152NLin6ASym | mm | 193 | valid identifier |
| on005415 | C | ACPC | m | 13 | ACPC; native space |
| on005448 | C | Other | mm | 18 | Other/ACPC native; The origin of the coordinate system is between the ears and the axis are in the RAS direction. The scaling is  |
| on005489 | D | MNI152NLin6ASym, Talairach | mm | 154 | valid identifier |
| on005491 | D | Talairach, MNI152NLin6ASym | mm | 51 | valid identifier |
| on005494 | D | MNI152NLin6ASym | mm | 51 | valid identifier |
| on005522 | D | MNI152NLin6ASym | mm | 176 | valid identifier |
| on005523 | D | MNI152NLin6ASym | mm | 102 | valid identifier |
| on005545 | F | none | none | 336 | no coordsystem file in sampled subjects; electrodes.tsv has numeric x/y/z |
| on005557 | D | MNI152NLin6ASym | mm | 58 | valid identifier |
| on005558 | D | MNI152NLin6ASym | mm | 22 | valid identifier |
| on005574 | E | MNI152NLin2009aSym, Other | mm, n/a | 9 | sub-level MNI152NLin2009aSym mm (valid) plus space-Other 'subject native space' file with units n/a and numeric coordinates |
| on005624 | F | none | none | 35 | no coordsystem and no electrodes file in sampled subjects |
| on005670 | D | MNI152Lin | mm | 2 | valid identifier; MNI152 |
| on005691 | F | none | none | 8 | catalog lists no latest_version, so no data could be read |
| on005931 | F | none | none | 16 | no coordsystem file in sampled subjects; electrodes.tsv has numeric x/y/z |
| on005953 | C | ACPC | mm | 3 | ACPC; native space |
| on006065 | D | MNI152NLin2009cAsym | mm | 45 | valid identifier |
| on006107 | F | none | none | 167 | no coordsystem file in sampled subjects; electrodes.tsv has numeric x/y/z |
| on006136 | D | MNI152Lin | mm | 14 | valid identifier |
| on006233 | F | none | none | 347 | no coordsystem file in sampled subjects; electrodes.tsv has numeric x/y/z |
| on006253 | E | fsaverage | m | 0 | fsaverage declared in units m but magnitudes up to 69.5 (mm scale); catalog recording_count 0 |
| on006392 | D | MNI152Lin | mm | 1 | valid identifier; MNI152 |
| on006519 | C | ScanRAS | mm | 35 | ScanRAS; native space |
| on006890 | C | Other | mm | 870 | Other, mm; relative 2D sheet-based system for monkey ECoG, left and right sheets independent |
| on006910 | C | Other | mm | 384 | Other/ACPC native; Post-implant CT coregistered to pre-implant MRI in patient-native RAS orientation. |
| on006914 | C | Other | mm | 353 | Other/ACPC native; Post-implant CT coregistered to pre-implant MRI in patient-native RAS orientation. |
| on007095 | C | ACPC | mm | 6019 | ACPC; native space |
| on007118 | D | fsaverage | mm | 82 | valid identifier; Coordinates of electrode contacts in FreeSurfer average brain (fsaverage) space. |
| on007119 | D | fsaverage | mm | 106 | valid identifier; Coordinates of electrode contacts in FreeSurfer average brain (fsaverage) space. |
| on007120 | D | fsaverage | mm | 70 | valid identifier; Coordinates of electrode contacts in FreeSurfer average brain (fsaverage) space. |
| on008610 | A3 | Other | mm | 0 | x/y/z n/a with no stated reason; depth_um column in electrodes.tsv; frame Other, mm, 'Stereotaxic coordinates relative to interaural line / ear bars'; catalog recording_count 0 |

## Datasets where a fixer needs a primary source (B1 and B2)

| Dataset | Class | Primary source named | What the description says |
|---|---|---|---|
| nm000352 | B1 | Kai J. Miller ECoG library (LOC package) | Other, mm; 'Talairach coordinates obtained via the source-documented LOC package'; Talairach has no variants but mm 'assumed ... not confirmed' |
| nm000356 | B2 | Bellier et al. 2023 (Pink Floyd ECoG) | Other, mm; 'MNI coordinates as provided by the authors ... exact MNI template variant is not stated' |
| nm000357 | B2 | Keles et al. 2024, DANDI 000623 | Other, mm; 'MNI152 template space as provided ... exact MNI152 template variant ... is not stated'; paper plots on MNI152NLin2009cAsym |
| nm000358 | B2 | Peterson et al. 2022 (AJILE12); Stolk et al. 2018 | Other, mm; 'warped into MNI space ... The exact MNI template is not stated' |
| nm000367 | B2 | Zheng et al. 2024 | Other, mm; 'aligned to the CIT168 template brain in MNI152 coordinates ... specific BIDS template label is not asserted' |
| nm000368 | B2 | Daume et al. 2024 (DANDI) | Other, mm; 'CITI168 Atlas Brain in MNI152 coordinates ... for visualization'; no space description in NWB |
| nm000369 | B2 | Stolk et al. 2019 | Other, mm; source 'does not name the coordinate system'; atlas look-ups 'suggesting template (MNI) space, which is not verified' |
| nm000377 | B2 | TDT Electrode_Locations.zip release (Balban et al.) | Other, mm; positions 'warped to a template'; 'The template is not named' (MNI not stated) |
| nm000404 | B2 | Hammer (channels_MNI of the release) | Other, mm; 'MNI coordinates of each bipolar channel ... Template variant not named' |
| nm000405 | B2 | Merk et al. | Other, m; 'MNI space as labelled by the authors (space-mni); the exact template is not stated'; Lead-DBS |
| nm000430 | B2 | Kocsis et al. (Information_sheet.xlsx) | Other, mm; 'MNI coordinates (mm) ... the MNI template is not stated' |
| nm000435 | B2 | Boran et al. | Other, mm; 'MNI space coordinates of the authors (template not specified in the release)' |
| nm000469 | B2 | Xie et al. 2026 (OSF release) | Other, mm; 'field name suggests Talairach space; the release does not state the template or the localisation method'; units assumed |
| nm000473 | B2 | Qin et al. 2023 | Other, mm for MNI file ('MNI template version is not stated'); main sidecars are ACPC mm; ACPC positions of all contacts also in sourcedata |
| nm000480 | B2 | Johnson et al. (working-memory gating) | Other, mm; 'release does not state which of the two spaces (native or MNI) chanpos is in' |
| nm000481 | B2 | Ngo, Fell, Staresina; doi:10.7554/eLife.57011 | Other, mm; 'MNI coordinates ... as listed in Table 3 of the article; template version is not stated' |
| nm000485 | B2 | Lochy et al. (001_channels_TAL-MNI_coordinates.xlsx) | Other, mm for MNI file ('template version is not stated'); parallel Talairach file declared Talairach mm |
| on003374 | B2 | Fedele et al. | Other, mm; 'MNI152, standard MNI space' (MNI152 family, variant not stated) |

Also relevant to a fixer: nm000455 (class E) names the Colin 22 template (variant stated) but its values are voxel indices, so a unit conversion would be needed before any label.
nm000357 notes the authors visualize on MNI152NLin2009cAsym, but states the variant used to compute the coordinates is unknown, so that label should not be asserted without the authors.

## What can be fixed at the source

- **B1 and B2 (18 datasets):** the frame is a template family but written as Other.
  The maintainers of the original release (the paper authors or data depositors) are the only ones who can state the variant; ask them, citing the file the coordinates came from.
  For B1 (nm000352) the family Talairach has no variants, so the frame can be corrected as soon as the unit is confirmed.
- **E (10 datasets):** fixable locally with no new information for the spelling and unit-label errors (on002799 identifier spelling, on004100 and on006253 unit label m versus mm-scale values).
  The voxel-index cases (nm000373, nm000455) need the template image grid to convert to millimeters; nm000253, nm000462 and nm000463 and the native-space file of on005574 need the authors to state frame or units; on003844 holds placeholder zeros.
- **A3 (9 datasets):** positional information exists in the dataset or its source but outside x/y/z; some can be mapped to documented frames (for example the sourcedata coordinates of nm000537 and nm000432) once the authors confirm the space.
- **F (25 datasets):** a missing coordsystem file can be written by the dataset owner when the electrodes file has numeric coordinates (on004370, on004551, on004752, on005007, on005545, on005931, on006107, on006233); the frame must come from the authors.
  The remaining F datasets have no electrodes file in the sampled subjects.
- **A1 and A2 (44 datasets):** cannot be fixed at the source by a maintainer of this platform because the original release has no coordinates (A1).
  Several A1 descriptions say the contacts were localized in the paper but the positions were not shared (for example nm000374, nm000396, nm000412, nm000446); a request to the authors is the only route.
  A2 (nm000241, nm000251) lack even an explanation; one should be added.
- **C (28 datasets):** native or subject space by design; these cannot be placed on a template without the subject imaging and a registration, which is outside a metadata fix.
- **D (33 datasets):** no action beyond monitoring; nm000360 has one subject without coordinates, and on004809 has sampled values outside the brain extent worth checking.


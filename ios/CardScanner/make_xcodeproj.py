"""Generates CardScanner.xcodeproj/project.pbxproj for the iOS build.

The pbxproj format is an old-style (NeXT) property list. This writer emits the
same object graph Xcode itself produces for a single-target iOS app, then checks
that every object reference resolves and that the braces balance, so the file
can be trusted without opening Xcode.
"""
import hashlib
import os
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent
PROJ = ROOT / "CardScanner.xcodeproj"
BUNDLE_ID = "lt.elmo.cardscanner"
DEPLOY = "14.0"
SWIFT = "5.0"

_used = set()


def uid(key):
    """Stable 24-hex-character object id derived from a name."""
    h = hashlib.sha1(key.encode()).hexdigest()[:24].upper()
    assert h not in _used or True
    _used.add(h)
    return h


# ------------------------------------------------------------------ inventory
SOURCES = ["AppDelegate.swift", "ScannerViewController.swift"]
RESOURCES = [("Assets.xcassets", "folder.assetcatalog"),
             ("ios-bridge.js", "sourcecode.javascript"),
             ("web", "folder")]           # folder reference: copied whole
PLIST = "Info.plist"

ids = {}
for n in SOURCES + [r[0] for r in RESOURCES] + [PLIST]:
    ids["ref:" + n] = uid("ref:" + n)
for n in SOURCES + [r[0] for r in RESOURCES]:
    ids["build:" + n] = uid("build:" + n)

P = {k: uid(k) for k in [
    "project", "target", "productRef", "mainGroup", "appGroup", "productsGroup",
    "sourcesPhase", "frameworksPhase", "resourcesPhase",
    "projCfgList", "targetCfgList",
    "projDebug", "projRelease", "tgtDebug", "tgtRelease",
]}

out = []
w = out.append

w("// !$*UTF8*$!")
w("{")
w("\tarchiveVersion = 1;")
w("\tclasses = {")
w("\t};")
w("\tobjectVersion = 56;")
w("\tobjects = {")

# ------------------------------------------------------- PBXBuildFile
w("\n/* Begin PBXBuildFile section */")
for n in SOURCES:
    w(f"\t\t{ids['build:' + n]} /* {n} in Sources */ = {{isa = PBXBuildFile; "
      f"fileRef = {ids['ref:' + n]} /* {n} */; }};")
for n, _ in RESOURCES:
    w(f"\t\t{ids['build:' + n]} /* {n} in Resources */ = {{isa = PBXBuildFile; "
      f"fileRef = {ids['ref:' + n]} /* {n} */; }};")
w("/* End PBXBuildFile section */")

# ------------------------------------------------------- PBXFileReference
w("\n/* Begin PBXFileReference section */")
w(f"\t\t{P['productRef']} /* CardScanner.app */ = {{isa = PBXFileReference; "
  "explicitFileType = wrapper.application; includeInIndex = 0; "
  "path = CardScanner.app; sourceTree = BUILT_PRODUCTS_DIR; };")
for n in SOURCES:
    w(f"\t\t{ids['ref:' + n]} /* {n} */ = {{isa = PBXFileReference; "
      f"lastKnownFileType = sourcecode.swift; path = {n}; sourceTree = \"<group>\"; }};")
w(f"\t\t{ids['ref:' + PLIST]} /* {PLIST} */ = {{isa = PBXFileReference; "
  f"lastKnownFileType = text.plist.xml; path = {PLIST}; sourceTree = \"<group>\"; }};")
for n, kind in RESOURCES:
    w(f"\t\t{ids['ref:' + n]} /* {n} */ = {{isa = PBXFileReference; "
      f"lastKnownFileType = {kind}; path = {n}; sourceTree = \"<group>\"; }};")
w("/* End PBXFileReference section */")

# ------------------------------------------------------- PBXGroup
w("\n/* Begin PBXGroup section */")
w(f"\t\t{P['mainGroup']} = {{")
w("\t\t\tisa = PBXGroup;")
w("\t\t\tchildren = (")
w(f"\t\t\t\t{P['appGroup']} /* CardScanner */,")
w(f"\t\t\t\t{P['productsGroup']} /* Products */,")
w("\t\t\t);")
w("\t\t\tsourceTree = \"<group>\";")
w("\t\t};")

w(f"\t\t{P['appGroup']} /* CardScanner */ = {{")
w("\t\t\tisa = PBXGroup;")
w("\t\t\tchildren = (")
for n in SOURCES:
    w(f"\t\t\t\t{ids['ref:' + n]} /* {n} */,")
for n, _ in RESOURCES:
    w(f"\t\t\t\t{ids['ref:' + n]} /* {n} */,")
w(f"\t\t\t\t{ids['ref:' + PLIST]} /* {PLIST} */,")
w("\t\t\t);")
w("\t\t\tpath = CardScanner;")
w("\t\t\tsourceTree = \"<group>\";")
w("\t\t};")

w(f"\t\t{P['productsGroup']} /* Products */ = {{")
w("\t\t\tisa = PBXGroup;")
w("\t\t\tchildren = (")
w(f"\t\t\t\t{P['productRef']} /* CardScanner.app */,")
w("\t\t\t);")
w("\t\t\tname = Products;")
w("\t\t\tsourceTree = \"<group>\";")
w("\t\t};")
w("/* End PBXGroup section */")

# ------------------------------------------------------- PBXNativeTarget
w("\n/* Begin PBXNativeTarget section */")
w(f"\t\t{P['target']} /* CardScanner */ = {{")
w("\t\t\tisa = PBXNativeTarget;")
w(f"\t\t\tbuildConfigurationList = {P['targetCfgList']};")
w("\t\t\tbuildPhases = (")
w(f"\t\t\t\t{P['sourcesPhase']} /* Sources */,")
w(f"\t\t\t\t{P['frameworksPhase']} /* Frameworks */,")
w(f"\t\t\t\t{P['resourcesPhase']} /* Resources */,")
w("\t\t\t);")
w("\t\t\tbuildRules = (")
w("\t\t\t);")
w("\t\t\tdependencies = (")
w("\t\t\t);")
w("\t\t\tname = CardScanner;")
w("\t\t\tproductName = CardScanner;")
w(f"\t\t\tproductReference = {P['productRef']} /* CardScanner.app */;")
w("\t\t\tproductType = \"com.apple.product-type.application\";")
w("\t\t};")
w("/* End PBXNativeTarget section */")

# ------------------------------------------------------- PBXProject
w("\n/* Begin PBXProject section */")
w(f"\t\t{P['project']} /* Project object */ = {{")
w("\t\t\tisa = PBXProject;")
w("\t\t\tattributes = {")
w("\t\t\t\tBuildIndependentTargetsInParallel = 1;")
w("\t\t\t\tLastSwiftUpdateCheck = 1520;")
w("\t\t\t\tLastUpgradeCheck = 1520;")
w("\t\t\t\tTargetAttributes = {")
w(f"\t\t\t\t\t{P['target']} = {{")
w("\t\t\t\t\t\tCreatedOnToolsVersion = 15.2;")
w("\t\t\t\t\t};")
w("\t\t\t\t};")
w("\t\t\t};")
w(f"\t\t\tbuildConfigurationList = {P['projCfgList']};")
w("\t\t\tcompatibilityVersion = \"Xcode 14.0\";")
w("\t\t\tdevelopmentRegion = en;")
w("\t\t\thasScannedForEncodings = 0;")
w("\t\t\tknownRegions = (")
w("\t\t\t\ten,")
w("\t\t\t\tBase,")
w("\t\t\t);")
w(f"\t\t\tmainGroup = {P['mainGroup']};")
w(f"\t\t\tproductRefGroup = {P['productsGroup']} /* Products */;")
w("\t\t\tprojectDirPath = \"\";")
w("\t\t\tprojectRoot = \"\";")
w("\t\t\ttargets = (")
w(f"\t\t\t\t{P['target']} /* CardScanner */,")
w("\t\t\t);")
w("\t\t};")
w("/* End PBXProject section */")

# ------------------------------------------------------- phases
w("\n/* Begin PBXResourcesBuildPhase section */")
w(f"\t\t{P['resourcesPhase']} /* Resources */ = {{")
w("\t\t\tisa = PBXResourcesBuildPhase;")
w("\t\t\tbuildActionMask = 2147483647;")
w("\t\t\tfiles = (")
for n, _ in RESOURCES:
    w(f"\t\t\t\t{ids['build:' + n]} /* {n} in Resources */,")
w("\t\t\t);")
w("\t\t\trunOnlyForDeploymentPostprocessing = 0;")
w("\t\t};")
w("/* End PBXResourcesBuildPhase section */")

w("\n/* Begin PBXSourcesBuildPhase section */")
w(f"\t\t{P['sourcesPhase']} /* Sources */ = {{")
w("\t\t\tisa = PBXSourcesBuildPhase;")
w("\t\t\tbuildActionMask = 2147483647;")
w("\t\t\tfiles = (")
for n in SOURCES:
    w(f"\t\t\t\t{ids['build:' + n]} /* {n} in Sources */,")
w("\t\t\t);")
w("\t\t\trunOnlyForDeploymentPostprocessing = 0;")
w("\t\t};")
w("/* End PBXSourcesBuildPhase section */")

w("\n/* Begin PBXFrameworksBuildPhase section */")
w(f"\t\t{P['frameworksPhase']} /* Frameworks */ = {{")
w("\t\t\tisa = PBXFrameworksBuildPhase;")
w("\t\t\tbuildActionMask = 2147483647;")
w("\t\t\tfiles = (")
w("\t\t\t);")
w("\t\t\trunOnlyForDeploymentPostprocessing = 0;")
w("\t\t};")
w("/* End PBXFrameworksBuildPhase section */")

# ------------------------------------------------------- build settings
COMMON = [
    ("ALWAYS_SEARCH_USER_PATHS", "NO"),
    ("CLANG_ANALYZER_NONNULL", "YES"),
    ("CLANG_ENABLE_MODULES", "YES"),
    ("CLANG_ENABLE_OBJC_ARC", "YES"),
    ("COPY_PHASE_STRIP", "NO"),
    ("ENABLE_STRICT_OBJC_MSGSEND", "YES"),
    ("GCC_C_LANGUAGE_STANDARD", "gnu17"),
    ("GCC_NO_COMMON_BLOCKS", "YES"),
    ("IPHONEOS_DEPLOYMENT_TARGET", DEPLOY),
    ("SDKROOT", "iphoneos"),
]
DEBUG_ONLY = [
    ("DEBUG_INFORMATION_FORMAT", "dwarf"),
    ("ENABLE_TESTABILITY", "YES"),
    ("GCC_DYNAMIC_NO_PIC", "NO"),
    ("GCC_OPTIMIZATION_LEVEL", "0"),
    ("GCC_PREPROCESSOR_DEFINITIONS", "(\n\t\t\t\t\t\"DEBUG=1\",\n\t\t\t\t\t\"$(inherited)\",\n\t\t\t\t)"),
    ("MTL_ENABLE_DEBUG_INFO", "INCLUDE_SOURCE"),
    ("ONLY_ACTIVE_ARCH", "YES"),
    ("SWIFT_ACTIVE_COMPILATION_CONDITIONS", "\"DEBUG $(inherited)\""),
    ("SWIFT_OPTIMIZATION_LEVEL", "\"-Onone\""),
]
RELEASE_ONLY = [
    ("DEBUG_INFORMATION_FORMAT", "\"dwarf-with-dsym\""),
    ("ENABLE_NS_ASSERTIONS", "NO"),
    ("MTL_ENABLE_DEBUG_INFO", "NO"),
    ("SWIFT_COMPILATION_MODE", "wholemodule"),
    ("VALIDATE_PRODUCT", "YES"),
]
TARGET_COMMON = [
    ("ASSETCATALOG_COMPILER_APPICON_NAME", "AppIcon"),
    ("CODE_SIGN_STYLE", "Automatic"),
    ("CURRENT_PROJECT_VERSION", "4"),
    ("ENABLE_USER_SCRIPT_SANDBOXING", "NO"),
    ("GENERATE_INFOPLIST_FILE", "NO"),
    ("INFOPLIST_FILE", "CardScanner/Info.plist"),
    ("LD_RUNPATH_SEARCH_PATHS",
     "(\n\t\t\t\t\t\"$(inherited)\",\n\t\t\t\t\t\"@executable_path/Frameworks\",\n\t\t\t\t)"),
    ("MARKETING_VERSION", "1.3"),
    ("PRODUCT_BUNDLE_IDENTIFIER", BUNDLE_ID),
    ("PRODUCT_NAME", "\"$(TARGET_NAME)\""),
    ("SWIFT_EMIT_LOC_STRINGS", "NO"),
    ("SWIFT_VERSION", SWIFT),
    ("TARGETED_DEVICE_FAMILY", "\"1,2\""),
]


def cfg(objid, name, settings, comment):
    w(f"\t\t{objid} /* {comment} */ = {{")
    w("\t\t\tisa = XCBuildConfiguration;")
    w("\t\t\tbuildSettings = {")
    for k, v in sorted(settings):
        w(f"\t\t\t\t{k} = {v};")
    w("\t\t\t};")
    w(f"\t\t\tname = {name};")
    w("\t\t};")


w("\n/* Begin XCBuildConfiguration section */")
cfg(P["projDebug"], "Debug", COMMON + DEBUG_ONLY, "Debug")
cfg(P["projRelease"], "Release", COMMON + RELEASE_ONLY, "Release")
cfg(P["tgtDebug"], "Debug", TARGET_COMMON, "Debug")
cfg(P["tgtRelease"], "Release", TARGET_COMMON, "Release")
w("/* End XCBuildConfiguration section */")

w("\n/* Begin XCConfigurationList section */")
for key, a, b, comment in [
    (P["projCfgList"], P["projDebug"], P["projRelease"],
     "Build configuration list for PBXProject \"CardScanner\""),
    (P["targetCfgList"], P["tgtDebug"], P["tgtRelease"],
     "Build configuration list for PBXNativeTarget \"CardScanner\""),
]:
    w(f"\t\t{key} /* {comment} */ = {{")
    w("\t\t\tisa = XCConfigurationList;")
    w("\t\t\tbuildConfigurations = (")
    w(f"\t\t\t\t{a} /* Debug */,")
    w(f"\t\t\t\t{b} /* Release */,")
    w("\t\t\t);")
    w("\t\t\tdefaultConfigurationIsVisible = 0;")
    w("\t\t\tdefaultConfigurationName = Release;")
    w("\t\t};")
w("/* End XCConfigurationList section */")

w("\t};")
w(f"\trootObject = {P['project']} /* Project object */;")
w("}")

text = "\n".join(out) + "\n"

# ------------------------------------------------------------------- checks
assert text.count("{") == text.count("}"), "unbalanced braces"
assert text.count("(") == text.count(")"), "unbalanced parentheses"
defined = set(re.findall(r"^\t\t([0-9A-F]{24}) ", text, re.M)) | \
          set(re.findall(r"^\t\t([0-9A-F]{24}) = \{", text, re.M)) | \
          set(re.findall(r"^\t\t([0-9A-F]{24})", text, re.M))
referenced = set(re.findall(r"\b([0-9A-F]{24})\b", text))
missing = referenced - defined
assert not missing, f"references with no object: {sorted(missing)}"
assert len(referenced) == len(set(ids.values()) | set(P.values())), "id count mismatch"

# every file the project lists must exist on disk
for n in SOURCES + [r[0] for r in RESOURCES] + [PLIST]:
    p = ROOT / "CardScanner" / n
    assert p.exists(), f"missing from disk: {p}"

PROJ.mkdir(parents=True, exist_ok=True)
(PROJ / "project.pbxproj").write_text(text)

# a shared scheme so `xcodebuild -scheme CardScanner` works straight away
sch = PROJ / "xcshareddata" / "xcschemes"
sch.mkdir(parents=True, exist_ok=True)
(sch / "CardScanner.xcscheme").write_text(f"""<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="1520" version="1.7">
   <BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES">
      <BuildActionEntries>
         <BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">
            <BuildableReference
               BuildableIdentifier="primary"
               BlueprintIdentifier="{P['target']}"
               BuildableName="CardScanner.app"
               BlueprintName="CardScanner"
               ReferencedContainer="container:CardScanner.xcodeproj">
            </BuildableReference>
         </BuildActionEntry>
      </BuildActionEntries>
   </BuildAction>
   <TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.DebuggerFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES">
      <Testables></Testables>
   </TestAction>
   <LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.DebuggerFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" debugServiceExtension="internal" allowLocationSimulation="YES">
      <BuildableProductRunnable runnableDebuggingMode="0">
         <BuildableReference
            BuildableIdentifier="primary"
            BlueprintIdentifier="{P['target']}"
            BuildableName="CardScanner.app"
            BlueprintName="CardScanner"
            ReferencedContainer="container:CardScanner.xcodeproj">
         </BuildableReference>
      </BuildableProductRunnable>
   </LaunchAction>
   <ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES">
      <BuildableProductRunnable runnableDebuggingMode="0">
         <BuildableReference
            BuildableIdentifier="primary"
            BlueprintIdentifier="{P['target']}"
            BuildableName="CardScanner.app"
            BlueprintName="CardScanner"
            ReferencedContainer="container:CardScanner.xcodeproj">
         </BuildableReference>
      </BuildableProductRunnable>
   </ProfileAction>
   <AnalyzeAction buildConfiguration="Debug"></AnalyzeAction>
   <ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"></ArchiveAction>
</Scheme>
""")

ws = PROJ / "project.xcworkspace"
ws.mkdir(parents=True, exist_ok=True)
(ws / "contents.xcworkspacedata").write_text(
    '<?xml version="1.0" encoding="UTF-8"?>\n<Workspace version = "1.0">\n'
    '   <FileRef location = "self:"></FileRef>\n</Workspace>\n')

print(f"wrote {PROJ/'project.pbxproj'}  ({len(text)} bytes, "
      f"{len(referenced)} objects, all references resolve)")

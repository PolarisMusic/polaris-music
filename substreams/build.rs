use anyhow::Result;
use std::env;
use std::path::PathBuf;
use substreams_antelope_abigen::Abigen;

fn main() -> Result<()> {
    // Generate into OUT_DIR rather than back into src/.
    //
    // Writing generated code into the source tree looks convenient and breaks
    // the moment the build is incremental: cargo's fingerprint for this script
    // lives in target/, so with target/ preserved between builds (the Docker
    // cache mount) cargo sees unchanged inputs and skips the script — while the
    // source tree, being a fresh COPY, no longer contains what it produced.
    // The build then fails with "file not found for module `polaris_music`".
    //
    // OUT_DIR is cargo's own answer to this: it lives alongside the fingerprint
    // that decides whether to regenerate, so the two can never disagree.
    let out = PathBuf::from(env::var("OUT_DIR")?).join("polaris_music.rs");

    Abigen::new("PolarisMusic", "abi/polaris.music.json")?
        .generate()?
        .write_to_file(&out)?;

    // Rebuild if ABI changes
    println!("cargo:rerun-if-changed=abi/polaris.music.json");

    Ok(())
}

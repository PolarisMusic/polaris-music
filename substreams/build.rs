use anyhow::Result;
use substreams_antelope_abigen::Abigen;

fn main() -> Result<()> {
    // Generate Rust bindings for Polaris Music Registry contract
    Abigen::new("PolarisMusic", "abi/polaris.music.json")?
        .generate()?
        .write_to_file("src/abi/polaris_music.rs")?;

    // Rebuild if ABI changes
    println!("cargo:rerun-if-changed=abi/polaris.music.json");

    Ok(())
}

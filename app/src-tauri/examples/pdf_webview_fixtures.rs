//! Test fixture projection using the same public mapper as parsing.
use std::{env, fs, io::Read};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = env::args().collect();
    if args.len() != 3 {
        return Err("usage: pdf_webview_fixtures <docling.json.gz> <blockmodel.json>".into());
    }
    let mut text = String::new();
    flate2::read::GzDecoder::new(fs::File::open(&args[1])?).read_to_string(&mut text)?;
    let mapped = paper30min_lib::pdfmap::map_docling_json_str(&text)
        .map_err(|error| format!("mapping failed: {error:?}"))?;
    fs::write(&args[2], serde_json::to_vec(&mapped)?)?;
    Ok(())
}

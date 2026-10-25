use orbit_ctf::Server;
use std::net::TcpListener;
use std::path::PathBuf;

fn main() -> std::io::Result<()> {
    let addr = std::env::var("LISTEN_ADDR").unwrap_or_else(|_| "127.0.0.1:8080".into());

    let root = PathBuf::from(std::env::var("DATA_DIR").unwrap_or_else(|_| "./data".into()));

    let listener = TcpListener::bind(&addr)?;

    eprintln!("orbit-navigation-service listening on {addr}");

    Server::new(root)?.serve(listener)
}

mod argv;
mod executor;
mod scenario;

use std::io::Write;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let invocation = argv::parse(&args);
    let exit_code = match invocation {
        argv::Invocation::PluginMarketplaceAdd(name) => {
            println!("[quantico] marketplace added: {}", name);
            0
        }
        argv::Invocation::PluginInstall(name) => {
            println!("[quantico] plugin installed: {}", name);
            0
        }
        argv::Invocation::Unsupported(arg) => {
            eprintln!("quantico: unsupported argument: {}", arg);
            2
        }
        argv::Invocation::Run { scenario: name, scenario_file, resume_session_id: _ } => {
            run_scenario(name.as_deref(), scenario_file.as_deref())
        }
    };
    std::process::exit(exit_code);
}

fn run_scenario(name: Option<&str>, scenario_file: Option<&str>) -> i32 {
    let scenario = if let Some(path) = scenario_file {
        match std::fs::read_to_string(path) {
            Ok(yaml) => match scenario::Scenario::parse(&yaml) {
                Ok(s) => s,
                Err(e) => { eprintln!("quantico: bad scenario file: {}", e); return 2; }
            },
            Err(e) => { eprintln!("quantico: cannot read scenario file: {}", e); return 2; }
        }
    } else {
        let n = name.unwrap_or("default");
        match scenario::lookup(n) {
            Some(s) => s,
            None => { eprintln!("quantico: unknown scenario: {}", n); return 2; }
        }
    };

    let speed_mult: f64 = std::env::var("MOCK_CLAUDE_SPEED_MULT")
        .ok().and_then(|s| s.parse().ok()).unwrap_or(1.0);
    let cwd = std::env::current_dir()
        .map(|p| p.display().to_string()).unwrap_or_else(|_| "?".into());
    let argv: Vec<String> = std::env::args().skip(1).collect();

    let env_get = |k: &str| std::env::var(k).ok();
    let mut stdout = std::io::stdout();
    let mut ctx = executor::ExecCtx {
        stdout: &mut stdout,
        speed_mult,
        env: &env_get,
        cwd,
        argv,
    };
    match executor::run(&scenario, &mut ctx) {
        Ok(executor::Outcome::Exited(c)) => c,
        Ok(executor::Outcome::SleepingForever) => {
            // Block forever (until SIGKILL). SIGTERM honoured by default.
            loop { std::thread::park(); }
        }
        Err(e) => {
            let _ = writeln!(std::io::stderr(), "quantico: io error: {}", e);
            1
        }
    }
}

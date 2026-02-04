# Auth Command

Manage provider authentication directly from the CLI.

## Usage

```bash
openclaw auth <provider> [options]
```

## Subcommands

### `google-antigravity` (alias: `antigravity`)

Authenticate with Google Antigravity (OAuth).

**Options:**

- `--manual`: Force the manual authentication flow. Useful for remote environments (SSH, Codespaces) where a local browser cannot be opened automatically.

**Examples:**

1.  **Standard Login (Local)**:

    ```bash
    openclaw auth antigravity
    ```

    This will open your default browser to the Google Sign-In page.

2.  **Manual Login (Remote)**:
    ```bash
    openclaw auth antigravity --manual
    ```
    This will print the Authentication URL to the terminal. Copy it to your local browser, sign in, and paste the redirect URL back into the terminal.

### `anthropic`

Authenticate with Anthropic (wraps `claude setup-token`).

**Usage:**

```bash
openclaw auth anthropic
```

**Description:**

This command guides you through the Anthropic authentication process. It will prompt you to run `claude setup-token` in your terminal (if you haven't already), and then paste the resulting token to save a new profile.

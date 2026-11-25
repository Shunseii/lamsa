# lamsa PR preview action

Posts before/after images of every screen a pull request changes, with new, changed and removed layers outlined in green, amber and red, plus what each value changed from and to. It's one comment that updates on each push. Screens that use a changed component are re-rendered too.

```yaml
# .github/workflows/lamsa.yml
name: lamsa
on:
  pull_request:
    paths: ["**/*.lamsa.json", "lamsa.config.json", "**/globals.css"]
permissions:
  contents: write        # pushes images to the lamsa-previews branch
  pull-requests: write   # posts the comment
jobs:
  preview:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: Shunseii/lamsa/action@main
```

Images live on a separate `lamsa-previews` branch so they never touch your history. The same diff runs locally: `lamsa diff origin/main --open`.

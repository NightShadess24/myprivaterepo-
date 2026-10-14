# Sources from other repositories

The `0.9/stable` repository also offers the sources of other public Paperback 0.9
repositories. `scripts/aggregate.mjs` copies their published bundles, unchanged,
when this repository is built (on every push and once a day). The list, with
each repository's license, is in `scripts/aggregate.config.json`; the homepage
credits each source and links to its repository, license and source code.

| Repository                                                                                                                  | License |
| --------------------------------------------------------------------------------------------------------------------------- | ------- |
| [inkdex/extensions](https://github.com/inkdex/extensions) (built from the [Inkdex](https://github.com/inkdex) repositories) | GPL-3.0 |
| [karrot0/KakarotExtension](https://github.com/karrot0/KakarotExtension)                                                     | MIT     |
| [Catta1997/Sinon-Paperback-Extensions](https://github.com/Catta1997/Sinon-Paperback-Extensions)                             | GPL-3.0 |
| [kittycatgit/kitty-extensions-0.9](https://github.com/kittycatgit/kitty-extensions-0.9)                                     | GPL-3.0 |
| [itskodama/paperback-extensions](https://github.com/itskodama/paperback-extensions)                                         | GPL-3.0 |
| [LucifersCircle/pirate.vodka-extensions](https://github.com/LucifersCircle/pirate.vodka-extensions)                         | GPL-3.0 |

Not included, because they don't allow copying (no license, or "all rights
reserved"): nyzzik/extensions, TheVodraz/paperback-extensions,
michaelasper/paperback-corruptbytes. They can still be added to Paperback on
their own.

License texts: `third-party/licenses/`.

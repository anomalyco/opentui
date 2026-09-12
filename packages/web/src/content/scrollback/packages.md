---
title: Packages
description: Features like LaTeX should live outside the monorepo. That forces us to improve our APIs and lowers what we review and maintain. There is a package index now.
date: 2026-08-16
tags: [packages, api, monorepo]
---

Sebastian and I have been discussing where features should go in OpenTUI.
We often get good feature requests, for instance LaTeX support, Mermaid
diagrams, you name it. These are good features that we want to support.

## Components

We went back and forth: should we put them into the monorepo, or should
we have them somewhere else? We sort of landed on having these components
use the library from the outside instead of inside.

Our rationale is twofold. First, this forces us to improve our APIs so our
shit works better for the common user. Second, it lowers the things we
need to review and maintain in OpenTUI.

There are nice things about putting everything into the monorepo. It is
easier, and it is nicer to work with from a developer perspective. But
this path seems like the right solution.

## APIs

We do not want to protect the API design. We want to improve the APIs.
If we force things to live outside, the API and core functionality
have to support the use cases people build on top of the library.
It is easier to pack things internally than to force them outside the
internal project.

LaTeX is nice, but maybe not the core functionality of the library.

## Packages

Internally, we structure OpenTUI as a monorepo with many packages. One is
the core package. Another will be the native package. We have a
React package and a Solid package, and you only pull the React or Solid
package if you use it.

If things live outside the monorepo, there should be a place to find
them. So the website has a package index now:
[opentui.com/packages](/packages). A package does not have to be a
component: many projects just use OpenTUI to build apps, and that is a
package as well. To add yours, open a pull request in
[anomalyco/opentui-index](https://github.com/anomalyco/opentui-index).

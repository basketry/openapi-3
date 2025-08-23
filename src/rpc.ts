#!/usr/bin/env node

import { RPC } from 'basketry';
import parser from '.';

new RPC({ parser }).execute();

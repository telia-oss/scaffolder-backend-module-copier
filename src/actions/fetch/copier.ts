/*
 * Copyright 2021 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  ContainerRunner,
  UrlReader,
  resolveSafeChildPath,
} from '@backstage/backend-common';
import { JsonObject, JsonValue } from '@backstage/types';
import { InputError } from '@backstage/errors';
import { ScmIntegrations } from '@backstage/integration';
import commandExists from 'command-exists';
import fs from 'fs-extra';
import path, { resolve as resolvePath } from 'path';
import { Writable } from 'stream';
import {
  createTemplateAction,
  fetchContents,
  executeShellCommand,
} from '@backstage/plugin-scaffolder-node'

export class CopierRunner {
  private readonly containerRunner?: ContainerRunner;

  constructor({ containerRunner }: { containerRunner?: ContainerRunner }) {
    this.containerRunner = containerRunner;
  }

  private async fetchTemplateCopier(
    directory: string,
  ): Promise<Record<string, JsonValue>> {
    try {
      return await fs.readJSON(path.join(directory, 'copier.json'));
    } catch (ex) {
      if (ex.code !== 'ENOENT') {
        throw ex;
      }

      return {};
    }
  }

  public async run({
    workspacePath,
    values,
    logStream,
    imageName,
    templateDir,
    templateContentsDir,
  }: {
    workspacePath: string;
    values: JsonObject;
    logStream: Writable;
    imageName?: string;
    templateDir: string;
    templateContentsDir: string;
  }): Promise<void> {
    const intermediateDir = path.join(workspacePath, 'intermediate');
    await fs.ensureDir(intermediateDir);
    const resultDir = path.join(workspacePath, 'result');

    // First lets grab the default copier.json file
    const copierJson = await this.fetchTemplateCopier(
      templateContentsDir,
    );

    const copierInfo = {
      ...copierJson,
      ...values,
    };

    await fs.writeJSON(path.join(templateDir, 'copier.json'), copierInfo);

    // Directories to bind on container
    const mountDirs = {
      [templateDir]: '/input',
      [intermediateDir]: '/output',
    };

    // the command-exists package returns `true` or throws an error
    const copierInstalled = await commandExists('copier').catch(
      () => false,
    );

    let copierValues: string[] = []
    console.log(values) 
    let destValues = values['destination']
    delete values['destination']
    console.log("destValues:", destValues)
    console.log("values", values)
    let allValues  = Object.assign({}, destValues, values);
    console.log(allValues)
    for (let key in allValues) {
      let value = allValues[key];
      copierValues.push("--data")
      copierValues.push(key + "=" + value)
    }
    const templateSource = templateDir+"/copier"
    const projectDestination = intermediateDir+"/copier"
    if (copierInstalled) {
      await executeShellCommand({
        command: 'copier',
        args: ['copy', ...copierValues, templateSource, projectDestination, '--trust'],
        logStream,
      });
    } else {
      if (this.containerRunner === undefined) {
        throw new Error(
          'Invalid state: containerRunner cannot be undefined when copier is not installed',
        );
      }

      await this.containerRunner.runContainer({
        imageName: imageName ?? 'tobiasestefors/copier:7.0.1',
        command: 'copier',
        args: [...copierValues, '/input', '/output'],
        mountDirs, 
        workingDir: '/input',
        envVars: { HOME: '/tmp' },
        logStream,
      });
    }

    const [generated] = await fs.readdir(intermediateDir);
    console.log(generated)
    if (generated === undefined) {
      throw new Error('No data generated by copier');
    }

    await fs.move(path.join(intermediateDir, generated), resultDir);
  }
}

/**
 * Creates a `fetch:copier` Scaffolder action.
 *
 * @remarks
 *
 * See {@link https://copier.readthedocs.io/} and {@link https://backstage.io/docs/features/software-templates/writing-custom-actions}.
 * @param options - Templating configuration.
 * @public
 */
export function createFetchCopierAction(options: {
  reader: UrlReader;
  integrations: ScmIntegrations;
  containerRunner?: ContainerRunner;
}) {
  const { reader, containerRunner, integrations } = options;

  return createTemplateAction<{
    url: string;
    targetPath?: string;
    values: JsonObject;
    imageName?: string;
  }>({
    id: 'fetch:copier',
    description:
      'Downloads a template from the given URL into the workspace, and runs copier on it.',
    schema: {
      input: {
        type: 'object',
        required: ['url'],
        properties: {
          url: {
            title: 'Fetch URL',
            description:
              'Relative path or absolute URL pointing to the directory tree to fetch',
            type: 'string',
          },
          targetPath: {
            title: 'Target Path',
            description:
              'Target path within the working directory to download the contents to.',
            type: 'string',
          },
          values: {
            title: 'Template Values',
            description: 'Values to pass on to copier for templating',
            type: 'object',
          },
          imageName: {
            title: 'Copier Docker image',
            description:
              "Specify a custom Docker image to run copier, to override the default: 'spotify/backstage-copier'. This can be used to execute copier with Template Extensions. Used only when a local copier is not found.",
            type: 'string',
          },
        },
      },
    },
    async handler(ctx) {
      ctx.logger.info('Fetching and then templating using copier');
      const workDir = await ctx.createTemporaryDirectory();
      const templateDir = resolvePath(workDir, 'template');
      const templateContentsDir = resolvePath(
        templateDir,
        "copier", 
      );
      const resultDir = resolvePath(workDir, 'result');

      if (
        ctx.input.copyWithoutRender &&
        !Array.isArray(ctx.input.copyWithoutRender)
      ) {
        throw new InputError(
          'Fetch action input copyWithoutRender must be an Array',
        );
      }
      if (ctx.input.extensions && !Array.isArray(ctx.input.extensions)) {
        throw new InputError('Fetch action input extensions must be an Array');
      } 
      await fetchContents({
        reader,
        integrations,
        baseUrl: ctx.templateInfo?.baseUrl,
        fetchUrl: ctx.input.url,
        outputPath: templateContentsDir,
      });

      const copier = new CopierRunner({ containerRunner });
      const values = {
        ...ctx.input.values 
      };

      await copier.run({
        workspacePath: workDir,
        logStream: ctx.logStream,
        values: values,
        imageName: ctx.input.imageName,
        templateDir: templateDir,
        templateContentsDir: templateContentsDir,
      });

      const targetPath = ctx.input.targetPath ?? './';
      const outputPath = resolveSafeChildPath(ctx.workspacePath, targetPath);
      await fs.copy(resultDir, outputPath);
    },
  });
}

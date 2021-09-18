
var AWS = require('aws-sdk');

var fs = require('fs');
const { v4: uuidv4 } = require('uuid');

var lexmodelsv2 = undefined; //new AWS.LexModelsV2();
var lexruntimev2 = undefined; //new AWS.LexRuntimeV2();
var cloudWatchLogs = undefined;

/**
 * Called by the main function to deploy a bot.
 * This function first checks to see if a bot exists and
 * creates it if if doesn't exist.
 * Then updates each intent and finally builds and publishes
 * it if there have been changes.
 */
async function deployBot(botConfig, envConfig)
{
  try
  {
    botConfig.status = {
      fullBotName: getBotName(botConfig, envConfig)
    };

    console.log(`[INFO] deploying bot: ${botConfig.status.fullBotName}`);

    // Check for duplicate data etc
    verifyBotConfig(botConfig);

    var bot = await getBot(botConfig, envConfig);
    var created = false;

    if (bot === undefined)
    {
      bot = await createBot(botConfig, envConfig);
      created = true;
    }

    botConfig.status.created = created;
    botConfig.status.botId = bot.botId;

    if (!await isBotLocaleAvailable(botConfig, envConfig))
    {
      await createBotLocale(botConfig, envConfig);
    }

    // Update intents
    await updateIntents(botConfig, envConfig);

    // Build the bot
    await buildBot(botConfig, envConfig);

    // Create a bot version waiting for it to be ready
    var botVersion = await createBotVersion(botConfig, envConfig);
    botConfig.status.botVersion = botVersion.botVersion;

    // Create or update the alias
    var challengerAliasId = await updateAlias(botVersion.botVersion, botConfig.challengerAlias, botConfig, envConfig);
    botConfig.status.challengerAliasId = challengerAliasId;

    if (created)
    {
      console.log('[INFO] bot created successfully: ' + JSON.stringify(botConfig.status, null, 2));
    }
    else
    {
      console.log('[INFO] bot updated successfully: ' + JSON.stringify(botConfig.status, null, 2));
    }

    // Test the bot
    await testBot(botConfig, envConfig);

    // If testing succeeds deploy the production alias
    console.log('[INFO] tests passed, deploying the production alias: ' + botConfig.productionAlias);
    var productionAliasId = await updateAlias(botVersion.botVersion, botConfig.productionAlias, botConfig, envConfig);
    botConfig.status.productionAliasId = productionAliasId;
    console.log('[INFO] production alias deployed successfully: ' + JSON.stringify(botConfig.status, null, 2));

    console.log('[INFO] granting access to Connect instance');
    var lexBotArn = createBotAliasArn(envConfig.region, envConfig.accountNumber, botConfig.status.botId, botConfig.status.productionAliasId);
    await grantConnectAccess(envConfig.accountNumber, envConfig.connectArn, lexBotArn);
    console.log('[INFO] access granted to Connect instance');

  }
  catch (error)
  {
    console.log('[ERROR] deploy failed: ' + error.message, error);
    throw error;
  }
}

/**
 * Verifies bot config detecting duplicate utterances and intent names
 */
function verifyBotConfig(botConfig)
{
  var uniqueIntentNames = new Set();
  var uniqueUtterances = new Set();

  botConfig.intents.forEach(intent => {
    var normalisedIntentName = intent.name.toLowerCase();

    if (uniqueIntentNames.has(normalisedIntentName))
    {
      throw new Error('Duplicate intent name found: ' + intent.name);
    }

    uniqueIntentNames.add(normalisedIntentName);

    intent.utterances.forEach(utterance => {
      var normalisedUtterance = utterance.toLowerCase();

      if (uniqueUtterances.has(normalisedUtterance))
      {
        throw new Error(`Duplicate utterance found: ${utterance} on intent: ${intent.name}`);
      }

      uniqueUtterances.add(normalisedUtterance);
    });

  });

  botConfig.status.verified = true;
}

/**
 * Updates the requested alias to point to the requested built version
 */
async function updateAlias(botVersion, alias, botConfig, envConfig)
{
  try
  {
    console.log('[INFO] updating alias: ' + alias);

    var existingAliases = await listBotAliases(botConfig, envConfig);

    var existingAlias = existingAliases.find(a => a.botAliasName === alias);

    if (existingAlias === undefined)
    {
      console.log('[INFO] alias not found, creating: ' + alias);
      var aliasDescription = await createBotAlias(botVersion, alias, botConfig, envConfig);
      return aliasDescription.botAliasId;
    }
    else
    {
      console.log('[INFO] alias found, updating: ' + alias);
      await updateBotAlias(botVersion, existingAlias.botAliasId, alias, botConfig, envConfig);
      return existingAlias.botAliasId;
    }

  }
  catch (error)
  {
    console.log('[ERROR] failed to update bot alias: ' + error.message);
    throw error;
  }
}

/**
 * Creates a bot alias from a bot version waiting for it to be ready
 */
async function createBotAlias(botVersion, botAlias, botConfig, envConfig)
{
  try
  {
    var request =
    {
      botAliasName: botAlias,
      botId: botConfig.status.botId,
      botAliasLocaleSettings: {},
      botVersion: botVersion,
      description: botConfig.description,
      sentimentAnalysisSettings:
      {
        detectSentiment: botConfig.detectSentiment
      }
    };

    // Set up logging if this is the production alias
    await setupLogging(request, botAlias, botConfig, envConfig);

    request.botAliasLocaleSettings[botConfig.localeId] =
    {
      enabled: true
    };

    var response = await lexmodelsv2.createBotAlias(request).promise();

    await sleepFor(2000);

    var aliasDescription = await describeBotAlias(response.botAliasId, botConfig, envConfig);

    while (aliasDescription.botAliasStatus !== 'Available' &&
      aliasDescription.botAliasStatus !== 'Failed')
    {
      console.log('[INFO] waiting for bot alias to create, status: ' + aliasDescription.botAliasStatus);
      await sleepFor(2000);
      aliasDescription = await describeBotAlias(response.botAliasId, botConfig, envConfig);
    }

    if (aliasDescription.botAliasStatus !== 'Available')
    {
      throw new Error('Bot alias did not create cleanly, status: ' + aliasDescription.botAliasStatus);
    }

    return aliasDescription;
  }
  catch (error)
  {
    console.log('[ERROR] failed to create bot alias: ' + error.message);
    throw error;
  }
}

/**
 * Creates a bot alias from a bot version wwaiting for it to be ready
 */
async function updateBotAlias(botVersion, botAliasId, botAlias, botConfig, envConfig)
{
  try
  {
    var request =
    {
      botAliasId: botAliasId,
      botAliasName: botAlias,
      botId: botConfig.status.botId,
      botAliasLocaleSettings: {},
      botVersion: botVersion,
      description: botConfig.description,
      sentimentAnalysisSettings:
      {
        detectSentiment: botConfig.detectSentiment
      }
    };

    // Set up logging if this is the production alias
    await setupLogging(request, botAlias, botConfig, envConfig);

    request.botAliasLocaleSettings[botConfig.localeId] =
    {
      enabled: true
    };

    var response = await lexmodelsv2.updateBotAlias(request).promise();

    await sleepFor(2000);

    var aliasDescription = await describeBotAlias(botAliasId, botConfig, envConfig);

    while (aliasDescription.botAliasStatus !== 'Available' &&
      aliasDescription.botAliasStatus !== 'Failed')
    {
      console.log('[INFO] waiting for bot alias to update, status: ' + aliasDescription.botAliasStatus);
      await sleepFor(2000);
      aliasDescription = await describeBotAlias(botAliasId, botConfig, envConfig);
    }

    if (aliasDescription.botAliasStatus !== 'Available')
    {
      throw new Error('Bot alias did not update cleanly, status: ' + aliasDescription.botAliasStatus);
    }

    return aliasDescription;
  }
  catch (error)
  {
    console.log('[ERROR] failed to update bot alias: ' + error.message);
    throw error;
  }
}

/**
 * Sets up cloud watch and S3 logging if required for the production alias
 */
async function setupLogging(request, botAlias, botConfig, envConfig)
{
  try
  {
    // If this is the production alias enable cloud watch and S3 conversational logging
    if (botAlias === botConfig.productionAlias)
    {
      var logGroupName = `/aws/lex/${botConfig.status.fullBotName}`;
      var cloudWatchArn = `arn:aws:logs:${envConfig.region}:${envConfig.accountNumber}:log-group:${logGroupName}`;
      var s3LogPrefix = `/aws/lex/${botConfig.status.fullBotName}`;
      var cloudWatchLogPrefix = botAlias;

      request.conversationLogSettings =
      {
        audioLogSettings:
        [
          {
            destination: {
              s3Bucket: {
                logPrefix: s3LogPrefix,
                s3BucketArn: envConfig.conversationalLogsBucketArn
              }
            },
            enabled: true
          }
        ],
        textLogSettings:
        [
          {
            destination: {
              cloudWatch: {
                cloudWatchLogGroupArn: cloudWatchArn,
                logPrefix: cloudWatchLogPrefix
              }
            },
            enabled: true
          }
        ]
      };

      botConfig.status.cloudWatchLogGroup = logGroupName;
      botConfig.status.cloudWatchLogArn = cloudWatchArn;
      botConfig.status.cloudWatchLogPrefix = cloudWatchLogPrefix;
      botConfig.status.s3LogBucket = envConfig.conversationalLogsBucketArn;
      botConfig.status.s3LogPrefix = s3LogPrefix;

      await createLogGroup(logGroupName);

      console.log('[INFO] enabling conversational logging for production alias');
    }
  }
  catch (error)
  {
    console.log('[ERROR] failed to set up logging', error);
    throw error;
  }
}

/**
 * Creates a log group if it doesn't exist
 */
async function createLogGroup(logGroupName)
{
  try
  {
    console.log('[INFO] checking log group status: ' + logGroupName);

    var listRequest = {
      limit: 50,
      logGroupNamePrefix: logGroupName
    };

    var exists = false;

    var logGroups = [];

    var listResponse = await cloudWatchLogs.describeLogGroups(listRequest).promise();
    logGroups = logGroups.concat(listResponse.logGroups);

    while (listResponse.nextToken !== undefined && listResponse.nextToken !== null)
    {
      listRequest.nextToken = listResponse.nextToken;
      listResponse = await cloudWatchLogs.describeLogGroups(listRequest).promise();
      logGroups = logGroups.concat(listResponse.logGroups);
    }

    if (logGroups.length === 0)
    {
      console.log('[INFO] log group is missing, creating: ' + logGroupName);
      var createRequest = {
        logGroupName: logGroupName
      };

      var createResponse = await cloudWatchLogs.createLogGroup(createRequest).promise();

      console.log('[INFO] created log group successfully: ' + logGroupName);
    }
    else
    {
      console.log('[INFO] log group already exists, skipping creating: ' + logGroupName);
    }
  }
  catch (error)
  {
    console.log('[ERROR] failed to create log group', error);
    throw error;
  }
}

/**
 * Describes a bot alias
 */
async function listBotAliases(botConfig, envConfig)
{
  try
  {
    var request =
    {
      botId: botConfig.status.botId
    };

    var response = await lexmodelsv2.listBotAliases(request).promise();
    return response.botAliasSummaries;
  }
  catch (error)
  {
    console.log('[ERROR] failed to list bot aliases: ' + error.message);
    throw error;
  }
}

/**
 * Updates all intents
 */
async function updateIntents(botConfig, envConfig)
{
  try
  {
    var intents = await listIntents(botConfig, envConfig);

    // Make sure all bots are created first
    for (var i = 0; i < botConfig.intents.length; i++)
    {
      var intentConfig = botConfig.intents[i];
      var existingIntent = intents.find(intent => intent.intentName === intentConfig.name);

      if (existingIntent === undefined)
      {
        console.log('[INFO] creating missing intent: ' + intentConfig.name);
        var intentId = await createIntent(intentConfig, botConfig, envConfig);
        console.log('[INFO] missing intent created: ' + intentConfig.name);
      }
    }

    intents = await listIntents(botConfig, envConfig);

    // Update the intent utterances
    for (var i = 0; i < botConfig.intents.length; i++)
    {
      var intentConfig = botConfig.intents[i];
      var existingIntent = intents.find(intent => intent.intentName === intentConfig.name);

      if (existingIntent === undefined)
      {
        throw new Error('Failed to find intent: ' + intentConfig.name);
      }

      console.log('[INFO] updating intent utterances: ' + intentConfig.name);
      await updateIntent(existingIntent, intentConfig, botConfig, envConfig);
      console.log('[INFO] intent utterances updated: ' + intentConfig.name);
    }
  }
  catch (error)
  {
    console.log('[ERROR] failed to check intents: ' + error.message);
    throw error;
  }
}

/**
 * Builds a bot
 */
async function buildBot(botConfig, envConfig)
{
  try
  {
    var request = {
      botId: botConfig.status.botId,
      botVersion: 'DRAFT',
      localeId: botConfig.localeId
    };

    var response = await lexmodelsv2.buildBotLocale(request).promise();

    var botLocale = await describeBotLocale(botConfig, envConfig);

    while (botLocale.botLocaleStatus !== 'Built' &&
      botLocale.botLocaleStatus !== 'Failed')
    {
      console.log('[INFO] waiting for bot to build, status: ' + botLocale.botLocaleStatus);
      await sleepFor(5000);
      botLocale = await describeBotLocale(botConfig, envConfig);
    }

    if (botLocale.botLocaleStatus !== 'Built')
    {
      throw new Error('Failed to build bot, found bot locale status: ' + botLocale.botLocaleStatus);
    }
  }
  catch (error)
  {
    console.log('[ERROR] build failed: ' + error.message);
    throw error;
  }
};

/**
 * Creates a bot version waiting for ready
 */
async function createBotVersion(botConfig, envConfig)
{
  try
  {
    var createVersionRequest = {
      botId: botConfig.status.botId,
      botVersionLocaleSpecification: {},
      description: botConfig.description
    };

    createVersionRequest.botVersionLocaleSpecification[botConfig.localeId] =
    {
      sourceBotVersion: 'DRAFT'
    };

    var createVersionResponse = await lexmodelsv2.createBotVersion(createVersionRequest).promise();

    await sleepFor(5000);

    var botVersionDescription = await describeBotVersion(createVersionResponse.botVersion, botConfig, envConfig);

    while (botVersionDescription.botStatus !== 'Available' &&
            botVersionDescription.botStatus !== 'Failed')
    {
      await sleepFor(5000);
      botVersionDescription = await describeBotVersion(createVersionResponse.botVersion, botConfig, envConfig);
    }

    if (botVersionDescription.botStatus !== 'Available')
    {
      throw new Error('Failed to create bot version, found bot version status: ' + botVersionDescription.botStatus);
    }

    return botVersionDescription;
  }
  catch (error)
  {
    console.log('[ERROR] failed to create bot version: ' + error.message);
    throw error;
  }
}

/**
 * Describes a bot alias for a version
 */
async function describeBotAlias(botAliasId, botConfig, envConfig)
{
  try
  {
    var request = {
      botId: botConfig.status.botId,
      botAliasId: botAliasId
    };

    var response = await lexmodelsv2.describeBotAlias(request).promise();

    return response;
  }
  catch (error)
  {
    console.log('[ERROR] failed to describe bot alias: ' + error.message);
    throw error;
  }
}

/**
 * Describes a bot locale for a version
 */
async function describeBotVersion(botVersion, botConfig, envConfig)
{
  try
  {
    var describeBotVersionRequest = {
      botId: botConfig.status.botId,
      botVersion: botVersion
    };

    var describeBotVersionResponse = await lexmodelsv2.describeBotVersion(describeBotVersionRequest).promise();

    return describeBotVersionResponse;
  }
  catch (error)
  {
    console.log('[ERROR] failed to describe bot version: ' + error.message);
    throw error;
  }
}

/**
 * Updates the intent in Lex
 */
async function updateIntent(existingIntent, intentConfig, botConfig, envConfig)
{
  try
  {
    var request = {
      botId: botConfig.status.botId,
      intentId: existingIntent.intentId,
      botVersion: 'DRAFT',
      intentName: intentConfig.name,
      description: intentConfig.description,
      localeId: botConfig.localeId,
      sampleUtterances: []
    };

    intentConfig.utterances.forEach(utterance =>
    {
      request.sampleUtterances.push({
        utterance: utterance
      });
    });

    var response = await lexmodelsv2.updateIntent(request).promise();
  }
  catch (error)
  {
    console.log('[ERROR] failed to update intent: ' + error.message);
    throw error;
  }
};

/**
 * Fetches the bot name in the format: <stage>-<bot name>
 */
function getBotName(botConfig, envConfig)
{
  return `${envConfig.stage}-${botConfig.name}`;
}

/**
 * Look up a bot and get its status
 */
async function getBot(botConfig, envConfig)
{
  try
  {
    var params = {
      filters: [
        {
          name: 'BotName',
          operator: 'EQ',
          values: [
            botConfig.status.fullBotName
          ]
        }
      ],
      maxResults: '100'
    };

    var response = await lexmodelsv2.listBots(params).promise();

    if (response.botSummaries.length === 1)
    {
      return response.botSummaries[0];
    }

    console.log('[INFO] no existing bot found for name: ' + botConfig.status.fullBotName);
    return undefined;
  }
  catch (error)
  {
    console.log(`[ERROR] failed to fetch bot: ${botConfig.status.fullBotName} cause: ${error.message}`);
    throw error;
  }
}

/**
 * Creates an intent
 */
async function createIntent(intentConfig, botConfig, envConfig)
{
  try
  {
    var request = {
      botId: botConfig.status.botId,
      botVersion: 'DRAFT',
      intentName: intentConfig.name,
      description: intentConfig.description,
      localeId: botConfig.localeId
    };

    var response = await lexmodelsv2.createIntent(request).promise();
    return response.intentId;
  }
  catch (error)
  {
    console.log('[ERROR] failed to create intent: ' + error.message);
    throw error;
  }
}

/**
 * Creates a bot locale
 */
async function createBotLocale(botConfig, envConfig)
{
  try
  {
    var createBotLocaleRequest = {
      botId: botConfig.status.botId,
      botVersion: 'DRAFT',
      localeId: botConfig.localeId,
      description: botConfig.description,
      nluIntentConfidenceThreshold: botConfig.confidenceThreshold,
      voiceSettings: {
        voiceId: botConfig.voice
      }
    };

    console.log('[INFO] creating bot locale');

    var createBotLocaleResponse = await lexmodelsv2.createBotLocale(createBotLocaleRequest).promise();

    while (!await isBotLocaleAvailable(botConfig, envConfig))
    {
      await sleepFor(2000);
    }

    console.log('[INFO] bot locale created');

    return describeBot(botConfig, envConfig);
  }
  catch (error)
  {
    console.log('[ERROR] failed to create bot: ' + error.message);
    throw error;
  }
}

/**
 * Creates a Lex bot and a locale
 */
async function createBot(botConfig, envConfig)
{
  try
  {
    var createBotRequest = {
      botName: botConfig.status.fullBotName,
      dataPrivacy: {
        childDirected: false
      },
      description: botConfig.description,
      idleSessionTTLInSeconds: botConfig.idleSessionTTLInSeconds,
      roleArn: envConfig.roleArn
    };

    var createBotResponse = await lexmodelsv2.createBot(createBotRequest).promise();

    botConfig.status.botId = createBotResponse.botId;

    while (!await isBotAvailable(botConfig, envConfig))
    {
      await sleepFor(2000);
    }

    return describeBot(botConfig, envConfig);
  }
  catch (error)
  {
    console.log('[ERROR] failed to create bot: ' + error.message);
    throw error;
  }
}

/**
 * Checks to see if the bot locale is available
 */
async function isBotLocaleAvailable(botConfig, envConfig)
{
  try
  {
    var response = await describeBotLocale(botConfig, envConfig);

    if (response.botLocaleStatus === 'Failed' || response.botLocaleStatus === 'Built' || response.botLocaleStatus === 'NotBuilt')
    {
      console.log('[INFO] bot locale is available with status: ' + response.botLocaleStatus)
      return true;
    }

    console.log('[INFO] bot locale is not yet available: ' + response.botLocaleStatus);
    return false;
  }
  catch (error)
  {
    return false;
  }
}

/**
 * Checks to see if the bot is available
 */
async function isBotAvailable(botConfig, envConfig)
{
  var response = await describeBot(botConfig, envConfig);

  if (response.botStatus === 'Available')
  {
    console.log('[INFO] bot is available')
    return true;
  }

  console.log('[INFO] bot is not yet available: ' + response.botStatus);
  return false;
};

/**
 * Describes a lex bot by bot id
 */
async function describeBot(botConfig, envConfig)
{
  try
  {
    var request = {
      botId: botConfig.status.botId
    };

    return await lexmodelsv2.describeBot(request).promise();
  }
  catch (error)
  {
    console.log('[ERROR] failed to describe bot: ' + error.message);
    throw error;
  }
};

/**
 * Describes a bot locale for the DRAFT version
 */
async function describeBotLocale(botConfig, envConfig)
{
  try
  {
    var describeBotLocaleRequest = {
      botId: botConfig.status.botId,
      botVersion: 'DRAFT',
      localeId: botConfig.localeId
    };

    return await lexmodelsv2.describeBotLocale(describeBotLocaleRequest).promise();
  }
  catch (error)
  {
    console.log('[WARN] failed to describe bot locale: ' + error.message);
    throw error;
  }
}

/**
 * Lists intents
 */
async function listIntents(botConfig, envConfig)
{
  try
  {
    var request = {
      botId: botConfig.status.botId,
      botVersion: 'DRAFT',
      localeId: botConfig.localeId
    };

    var intents = [];

    var response = await lexmodelsv2.listIntents(request).promise();

    intents = intents.concat(response.intentSummaries);

    while (response.nextToken !== null)
    {
      request.nextToken = response.nextToken;
      response = await lexmodelsv2.listIntents(request).promise();
      intents = intents.concat(response.intentSummaries);
    }

    return intents;
  }
  catch (error)
  {
    console.log('[ERROR] failed to list intents: ' + error.message);
    throw error;
  }
}

/**
 * Deletes a lex session
 */
async function deleteSession(sessionId, aliasId, botConfig, envConfig)
{
  try
  {
    var request = {
      botAliasId: aliasId,
      botId: botConfig.status.botId,
      localeId: botConfig.localeId,
      sessionId: sessionId
    };

    await lexruntimev2.deleteSession(request).promise();
  }
  catch (error)
  {
    console.log('[WARNING] failed to delete session: ' + error.message);
  }
}

/**
 * Run all of the tests and verify the results using the challenger alias id
 */
async function testBot(botConfig, envConfig)
{
  var failures = 0;
  var results = [];

  try
  {
    for (var i = 0; i < botConfig.intents.length; i++)
    {
      var intentToTest = botConfig.intents[i];

      console.log('[INFO] Testing intent: ' + intentToTest.name);

      var intentResult = {
        intent: intentToTest.name,
        success: 0,
        fail: 0,
        problems: []
      };

      for (var t = 0; t < intentToTest.tests.length; t++)
      {
        var inferenceRequest = {
          botAliasId: botConfig.status.challengerAliasId,
          botId: botConfig.status.botId,
          localeId: botConfig.localeId,
          sessionId: uuidv4(),
          text: intentToTest.tests[t]
        };

        var inferenceResponse = await lexruntimev2.recognizeText(inferenceRequest).promise();

        await deleteSession(inferenceRequest.sessionId, botConfig.status.challengerAliasId, botConfig, envConfig);

        var interpretation = inferenceResponse.interpretations[0];

        if (interpretation.intent.name === intentToTest.name)
        {
          if (interpretation.nluConfidence !== undefined && interpretation.nluConfidence.score > 0.7)
          {
            intentResult.success++;
          }
          else
          {
            failures++;
            intentResult.fail++;
            intentResult.problems.push({
              text: intentToTest.tests[t],
              cause: 'Low confidence: ' + interpretation.nluConfidence.score
            });
          }
        }
        else
        {
          failures++;
          intentResult.fail++;
          intentResult.problems.push({
            text: intentToTest.tests[t],
            cause: 'Intent mismatch: ' + interpretation.intent.name
          });
        }
      }

      results.push(intentResult);
    }

    console.log('[INFO] test results: ' + JSON.stringify(results, null, 2));

    if (failures > 0)
    {
      throw new Error(`Detected ${failures} failed test(s)`);
    }
  }
  catch (error)
  {
    console.log('[ERROR] tests failed: ' + error.message);
    throw error;
  }
}

/**
 * Main setup function that parses command line inputs for the environment
 * and the bot to deploy
 */
async function main()
{
  var myArgs = process.argv.slice(2);

  if (myArgs.length != 2)
  {
    console.log('[ERROR] usage: node deploy_lex_bot.js <bot file> <config file>');
    process.exit(1);
  }

  try
  {
    var botConfig = JSON.parse(fs.readFileSync(myArgs[0], 'UTF-8'));
    var envConfig = JSON.parse(fs.readFileSync(myArgs[1], 'UTF-8'));

    if (envConfig.profileName !== undefined)
    {
      var credentials = new AWS.SharedIniFileCredentials({profile: envConfig.profileName});
      AWS.config.credentials = credentials;
      console.log('[INFO] using named profile: ' + envConfig.profileName);
    }

    lexmodelsv2 = new AWS.LexModelsV2({region: envConfig.region});
    lexruntimev2 = new AWS.LexRuntimeV2({region: envConfig.region});
    cloudWatchLogs = new AWS.CloudWatchLogs({region: envConfig.region});

    // Deploy the bot
    await deployBot(botConfig, envConfig);

    console.log('[INFO] successfully tested and deployed bot: ' + botConfig.status.fullBotName);

  }
  catch (error)
  {
    console.log(`[ERROR] deploying bot failed due to: ${error.message}`, error);
    process.exit(1);
  }
}

/**
 * Fetches a bot alias arn for a bot
 */
function createBotAliasArn(region, accountNumber, botId, botAliasId)
{
  try
  {
    var arn = `arn:aws:lex:${region}:${accountNumber}:bot-alias/${botId}/${botAliasId}`;

    console.log('[INFO] created lex bot arn: ' + arn);

    return arn;
  }
  catch (error)
  {
    console.log('[ERROR] failed to create bot alias', error);
    throw error;
  }
};

/**
 * Creates a resource policy allowing Connect to access the lex bot
 */
async function grantConnectAccess(accountNumber, connectInstanceArn, lexBotArn)
{
  try
  {
    var policy = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: {
            Service: 'connect.amazonaws.com'
          },
          Action: [
            'lex:RecognizeText',
            'lex:StartConversation',
          ],
          Resource: lexBotArn,
          Condition: {
            StringEquals: {
              'AWS:SourceAccount': accountNumber
            },
            ArnEquals:
            {
              'AWS:SourceArn': connectInstanceArn
            }
          }
        }
      ]
    };

    try
    {
      var describeRequest = {
        resourceArn: lexBotArn
      };

      var response = await lexmodelsv2.describeResourcePolicy(describeRequest).promise();

      var updateRequest = {
        policy: JSON.stringify(policy),
        resourceArn: lexBotArn,
        expectedRevisionId: response.revisionId
      };

      await lexmodelsv2.updateResourcePolicy(updateRequest).promise();
      console.log('[INFO] updated resource policy');
    }
    catch (error)
    {

      var createRequest = {
        policy: JSON.stringify(policy),
        resourceArn: lexBotArn
      };

      await lexmodelsv2.createResourcePolicy(createRequest).promise();
      console.log('[INFO] created resource policy');
    }
  }
  catch (error)
  {
    console.log('Failed to associate Lex bot with Connect instance', error);
    throw error;
  }
}

/**
 * Sleeps for the requested time
 */
function sleepFor(millis)
{
  return new Promise((resolve) => setTimeout(resolve, millis));
}

// Call the main function
main();

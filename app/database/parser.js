const cp = require('child_process');
const fs = require('fs');
const ReplayTypes = require('./constants.js');

const ReplayDataType = {
  game: "gameevents",
  message: "messageevents",
  tracker: "trackerevents",
  attribute: "attributeevents",
  header: "header",
  details: "details",
  init: "initdata",
  stats: "stats"
};

const ReplayStatus = {
  OK: 1,
  Unsupported: 0,
  Duplicate: -1,
  Failure: -2
};

// it's everything except gameevents which is just a massive amount of data
const CommonReplayData = [ReplayDataType.message, ReplayDataType.tracker, ReplayDataType.attribute, ReplayDataType.header, ReplayDataType.details, ReplayDataType.init, ReplayDataType.stats];
const AllReplayData = [ReplayDataType.game, ReplayDataType.message, ReplayDataType.tracker, ReplayDataType.attribute, ReplayDataType.header, ReplayDataType.details, ReplayDataType.init, ReplayDataType.stats];

// this just wraps the reference python implementation inside of
// a javascript module and will return json objects containing the different
// bundles of data provided by the parser.
// this file also assumes the existence of python on the host computer
function parse(file, requestedData, opts) {
  var replay = {};

  // execute sync
  for (var i in requestedData) {
    console.log("Retrieving " + requestedData[i]);

    const script = cp.spawnSync('python', ['../third_party/heroprotocol/heroprotocol.py','--json', '--' + requestedData[i], file], {
      maxBuffer: 500000*1024    // if anyone asks why it's 500MB it's because gameevents is huge
    });

    var rawData = `${script.stdout}`;

    // each line is a new json object
    rawData = rawData.replace(/\}\r?\n\{/g, '},\n{');
    rawData = rawData.replace(/\]\r?\n\{/g, '],\n{');

    rawData = '[' + rawData + ']';

    replay[requestedData[i]] = JSON.parse(rawData);
  }

  if (opts) {
    if ('saveToFile' in opts) {
      fs.writeFile(opts.saveToFile, JSON.stringify(replay, null, 2), function (err) {
        if (err) throw err;
        console.log('Wrote replay data to ' + opts.saveToFile);
      });
    }
  }

  return replay;
}

// processes a replay file and adds it to the database
function processReplay(file, opts = {}) {
  // options
  if (!('getBMData' in opts))
    opts.getBMData = true;

  try {
    console.log("Parsing " + file);

    // parse it
    var data;

    if (opts.getBMData) {
      data = parse(file, AllReplayData);
    }
    else {
      data = parse(file, CommonReplayData);
    }

    var details = data.details[0];

    // start with the match, since a lot of things are keyed off of it
    // the match id is not generated until insertion (key off unique id generated by database)
    // TODO: de-duplication
    var match = {};

    // header data
    match.version = data.header[0].m_version;
    match.type = data.header[0].m_type;
    match.loopLength = data.header[0].m_elapsedGameLoops;
    match.filename = file;

    // map details
    match.map = details.m_title;
    match.date = winFileTimeToDate(details.m_timeUTC);
    match.rawDate = details.m_timeUTC;

    // game mode
    match.mode = data.initdata[1].m_syncLobbyState.m_gameDescription.m_gameOptions.m_ammId;

    console.log("Processing " + ReplayTypes.GameModeStrings[match.mode]  + " game on " + match.map + " at " + match.date);

    // check for supported mode
    if (match.mode === ReplayTypes.GameMode.Brawl) {
      console.log("Brawls are not supported!");
      return { status: ReplayStatus.Unsupported };
    }

    // ai n stuff is ok, we can just filter it out of the database

    // check for duplicate matches somewhere else, this function executes without async calls
    // until insertion. Should have a processReplays function that does the de-duplication.
    //this._db.matches.find({ 'map' : match.map, 'date' : match.date, 'loopLength' : match.loopLength }, function(err, docs) {

    // players
    // the match will just store the players involed. The details will be stored
    // in a document in the heroData db
    // players are 1-indexed, look at details first
    var players = {};

    match.playerIDs = [];
    match.team0 = [];
    match.team1 = [];
    var playerDetails = details.m_playerList;

    console.log("Gathering Preliminary Player Data...");
    for (var i = 0; i < playerDetails.length; i++) {
      var pdata = playerDetails[i];
      var pdoc = {};

      // collect data
      pdoc.hero = pdata.m_hero;
      pdoc.name = pdata.m_name;
      pdoc.uuid = pdata.m_toon.m_id;
      pdoc.region = pdata.m_toon.m_region;
      pdoc.realm = pdata.m_toon.m_realm;
      pdoc.team = pdata.m_teamId;  /// the team id doesn't neatly match up with the tracker events, may adjust later
      pdoc.ToonHandle = pdata.m_toon.m_realm + '-' + pdata.m_toon.m_programId + '-' + pdata.m_toon.m_region + '-' + pdata.m_toon.m_id;
      pdoc.gameStats = {};
      pdoc.talents = {};
      pdoc.takedowns = [];
      pdoc.deaths = [];
      pdoc.gameStats.awards = [];
      pdoc.bsteps = [];
      pdoc.voiceLines = [];
      pdoc.sprays = [];
      pdoc.taunts = [];
      pdoc.dances = [];

      if (pdoc.team === ReplayTypes.TeamType.Blue) {
        match.team0.push(pdoc.ToonHandle);
      }
      else if (pdoc.team === ReplayTypes.TeamType.Red) {
        match.team1.push(pdoc.ToonHandle);
      }

      players[pdoc.ToonHandle] = pdoc;
      match.playerIDs.push(pdoc.ToonHandle);

      console.log("Found player " + pdoc.ToonHandle + " (" + pdoc.name+ ")");
    }

    console.log("Preliminary Player Processing Complete");
    console.log("Matching Tracker Player ID to handles...");
    // construct identfier map for player handle to internal player object id
    var tracker = data.trackerevents;

    // maps player id in the Tracker data to the proper player object
    var playerIDMap = {};
    match.loopGameStart = 0; // fairly sure this is always 610 but just in case look for the "GatesOpen" event

    for (let i = 0; i < tracker.length; i++) {
      let event = tracker[i];

      // case on event type
      if (event._eventid === ReplayTypes.TrackerEvent.Stat) {
        if (event.m_eventName === ReplayTypes.StatEventType.PlayerInit) {
          playerIDMap[event.m_intData[0].m_value] = event.m_stringData[1].m_value;

          console.log("Player " + event.m_stringData[1].m_value + " has tracker ID " + event.m_intData[0].m_value);
        }
        else if (event.m_eventName === ReplayTypes.StatEventType.GatesOpen) {
          match.loopGameStart = event._gameloop;
        }
      }
    }

    match.length = loopsToSeconds(match.loopLength - match.loopGameStart);

    console.log("Player ID Mapping Complete");

    // the tracker events have most of the useful data
    // track a few different kinds of things here, this is probably where most of the interesting stuff will come from
    match.XPBreakdown = [];
    match.takedowns = [];
    match.team0Takedowns = 0;
    match.team1Takedowns = 0;

    match.objective = { type: match.map };

    // objective object initialization (per-map)
    if (match.map === ReplayTypes.MapType.SkyTemple || match.map === ReplayTypes.MapType.Towers) {
      match.objective[0] = { count: 0, damage: 0, events: [] };
      match.objective[1] = { count: 0, damage: 0, events: [] };
    }
    else if (match.map === ReplayTypes.MapType.Cursed) {
      match.objective.tributes = [];
      match.objective[0] = {count: 0, events: []};
      match.objective[1] = {count: 0, events: []};
    }
    else if (match.map === ReplayTypes.MapType.Mines) {
      // unfortunately the mines map seems to be missing some older events that had the info about the golem spawns
      // the data would be... tricky to reconstruct due to ambiguity over who picks up the skull
      // we can track when these are summoned though and maybe how long they last
      var golems = [null, null];
      match.objective[0] = [];
      match.objective[1] = [];
    }
    else if (match.map === ReplayTypes.MapType.BOE) {
      match.objective.results = [];
    }

    var team0XPEnd;
    var team1XPEnd;

    // player 11 = blue (0) team ai?, player 12 = red (0) team ai?
    var possibleMinionXP = { "0" : 0, "1" : 0 };

    console.log("[TRACKER] Starting Event Analysis...");

    for (let i = 0; i < tracker.length; i++) {
      let event = tracker[i];

      // case on event type
      if (event._eventid === ReplayTypes.TrackerEvent.Score) {
        // score is real long, separate function
        processScoreArray(event.m_instanceList, match, players, playerIDMap);
      }
      else if (event._eventid === ReplayTypes.TrackerEvent.Stat) {
        if (event.m_eventName === ReplayTypes.StatEventType.EndOfGameTalentChoices) {
          let trackerPlayerID = event.m_intData[0].m_value;
          let playerID = playerIDMap[trackerPlayerID];

          console.log("[TRACKER] Processing Talent Choices for " + playerID);

          // this actually contains more than talent choices
          if (event.m_stringData[1].m_value === "Win") {
            players[playerID].win = true;
          }
          else {
            players[playerID].win = false;
          }

          players[playerID].internalHeroName = event.m_stringData[0].m_value;

          // talents
          for (let j = 0; j < event.m_stringData.length; j++) {
            if (event.m_stringData[j].m_key.startsWith('Tier')) {
              players[playerID].talents[event.m_stringData[j].m_key] = event.m_stringData[j].m_value;
            }
          }
        }
        else if (event.m_eventName === ReplayTypes.StatEventType.PeriodicXPBreakdown) {
          // periodic xp breakdown
          let xpb = {};
          xpb.loop = event._gameloop;
          xpb.time = loopsToSeconds(xpb.loop - match.loopGameStart);
          xpb.team = event.m_intData[0].m_value - 1;  // team is 1-indexed in this event?
          xpb.teamLevel = event.m_intData[1].m_value;
          xpb.breakdown = {};
          xpb.theoreticalMinionXP = possibleMinionXP[xpb.team];

          console.log("[TRACKER] Processing XP Breakdown for team " + xpb.team + " at loop " + xpb.loop);

          for (let j in event.m_fixedData) {
            xpb.breakdown[event.m_fixedData[j].m_key] = event.m_fixedData[j].m_value / 4096;
          }

          match.XPBreakdown.push(xpb);
        }
        else if (event.m_eventName === ReplayTypes.StatEventType.EndOfGameXPBreakdown) {
          // end of game xp breakdown
          let xpb = {};
          xpb.loop = event._gameloop;
          xpb.time = loopsToSeconds(xpb.loop - match.loopGameStart);
          xpb.team = players[playerIDMap[event.m_intData[0].m_value]].team;
          xpb.theoreticalMinionXP = possibleMinionXP[xpb.team];
          xpb.breakdown = {};

          console.log("[TRACKER] Caching Final XP Breakdown for team " + xpb.team + " at loop " + xpb.loop);

          for (let j in event.m_fixedData) {
            xpb.breakdown[event.m_fixedData[j].m_key] = event.m_fixedData[j].m_value / 4096;
          }

          if (xpb.team === ReplayTypes.TeamType.Blue) {
            team0XPEnd = xpb;
          }
          else if (xpb.team === ReplayTypes.TeamType.Red) {
            team1XPEnd = xpb;
          }
        }
        else if (event.m_eventName === ReplayTypes.StatEventType.PlayerDeath) {
          // add data to the match and the individual players
          let tData = {};
          tData.loop = event._gameloop;
          tData.time = loopsToSeconds(tData.loop - match.loopGameStart);
          tData.x = event.m_fixedData[0].m_value;
          tData.y = event.m_fixedData[1].m_value;
          tData.killers = [];

          // player ids
          let victim;
          let killers = [];

          for (let j = 0; j < event.m_intData.length; j++) {
            let entry = event.m_intData[j];

            if (entry.m_key === "PlayerID") {
              tData.victim = { player: playerIDMap[entry.m_value], hero: players[playerIDMap[entry.m_value]].hero };
              victim = playerIDMap[entry.m_value];
            }
            else if (entry.m_key === "KillingPlayer") {
              let tdo = { player: playerIDMap[entry.m_value], hero: players[playerIDMap[entry.m_value]].hero };
              killers.push(playerIDMap[entry.m_value]);
              tData.killers.push(tdo);
            }
          }

          if (players[victim].team === ReplayTypes.TeamType.Blue)
            match.team1Takedowns += 1;
          else if (players[victim].team === ReplayTypes.TeamType.Red)
            match.team0Takedowns += 1;

          match.takedowns.push(tData);
          players[victim].deaths.push(tData);
          for (let j = 0; j < killers.length; j++) {
            players[killers[j]].takedowns.push(tData);
          }

          console.log('[TRACKER] Processed Player ' + victim + ' death at ' + tData.loop);
        }
        else if (event.m_eventName === ReplayTypes.StatEventType.LootSprayUsed) {
          let spray = {};
          let id = event.m_stringData[1].m_value;
          spray.kind = event.m_stringData[2].m_value;
          spray.x = event.m_fixedData[0].m_value;
          spray.y = event.m_fixedData[1].m_value;
          spray.loop = event._gameloop;
          spray.time = loopsToSeconds(spray.loop - match.loopGameStart);
          spray.kills = 0;
          spray.deaths = 0;

          players[id].sprays.push(spray);

          console.log('[TRACKER] Spray from player ' + id + ' found');
        }
        else if (event.m_eventName === ReplayTypes.StatEventType.LootVoiceLineUsed) {
          let line = {};
          let id = event.m_stringData[1].m_value;
          line.kind = event.m_stringData[2].m_value;
          line.x = event.m_fixedData[0].m_value;
          line.y = event.m_fixedData[1].m_value;
          line.loop = event._gameloop;
          line.time = loopsToSeconds(line.loop - match.loopGameStart);
          line.kills = 0;
          line.deaths = 0;

          players[id].voiceLines.push(line);

          console.log('[TRACKER] Voice Line from player ' + id + ' found');
        }
        else if (event.m_eventName === ReplayTypes.StatEventType.SkyTempleShotsFired) {
          let objEvent = { team: event.m_intData[2].m_value - 1, loop: event._gameloop, damage: event.m_fixedData[0].m_value / 4096 };
          objEvent.time = loopsToSeconds(objEvent.loop - match.loopGameStart);

          match.objective[objEvent.team].events.push(objEvent);
          match.objective[objEvent.team].damage += objEvent.damage;
          match.objective[objEvent.team].count += 1;

          console.log("[TRACKER] Sky Temple: Shot fired for team " + objEvent.team);
        }
        else if (event.m_eventName === ReplayTypes.StatEventType.AltarCaptured) {
          let objEvent = { team: event.m_intData[0].m_value - 1, loop: event._gameloop, owned: event.m_intData[1].m_value };
          objEvent.damage = objEvent.owned + 1;
          objEvent.time = loopsToSeconds(objEvent.loop - match.loopGameStart);

          match.objective[objEvent.team].events.push(objEvent);
          match.objective[objEvent.team].damage += objEvent.damage;
          match.objective[objEvent.team].count += 1;

          console.log("[TRACKER] Towers of Doom: Altar Capture for team " + objEvent.team);
        }
        else if (event.m_eventName === ReplayTypes.StatEventType.ImmortalDefeated) {
          let objEvent = { winner: event.m_intData[1].m_value - 1, loop: event._gameloop, duration: event.m_intData[2].m_value };
          objEvent.time = loopsToSeconds(objEvent.loop - match.loopGameStart);
          objEvent.power = event.m_fixedData[0].m_value / 4096;

          console.log("[TRACKER] Immortal Fight Completed");

          match.objective.results.push(objEvent);
        }
        else if (event.m_eventName === ReplayTypes.StatEventType.TributeCollected) {
          let objEvent = { team: event.m_fixedData[0].m_value / 4096 - 1, loop: event._gameloop };
          objEvent.time = loopsToSeconds(objEvent.loop - match.loopGameStart);
          
          match.objective[objEvent.team].events.push(objEvent);
          match.objective[objEvent.team].count += 1;

          console.log("[TRACKER] Tribute collected by team " + objEvent.team);
        }
      }
      else if (event._eventid === ReplayTypes.TrackerEvent.UnitBorn) {
        // there's going to be a special case for tomb once i figure out the map name for it
        // unit type
        let type = event.m_unitTypeName;

        // if it's a minion...
        if (type in ReplayTypes.MinionXP) {
          let elapsedGameMinutes = parseInt(loopsToSeconds(event._gameloop - match.loopGameStart) / 60);

          if (elapsedGameMinutes > 30)
            elapsedGameMinutes = 30;

          let xpVal = ReplayTypes.MinionXP[type][elapsedGameMinutes];

          if (event.m_upkeepPlayerId === 11)
            possibleMinionXP[ReplayTypes.TeamType.Blue] += xpVal;
          else if (event.m_upkeepPlayerId === 12)
            possibleMinionXP[ReplayTypes.TeamType.Red] += xpVal;
        }
        else if (type === ReplayTypes.UnitType.MinesBoss) {
          let spawn = { loop: event._gameloop, team: event.m_controlPlayerId - 11 };
          spawn.time = loopsToSeconds(spawn.loop - match.loopGameStart);
          spawn.unitTagIndex = event.m_unitTagIndex;
          spawn.unitTagRecycle = event.m_unitTagRecycle;

          golems[spawn.team] = spawn;
        }
        else if (type === ReplayTypes.UnitType.RavenLordTribute) {
          let spawn = { loop: event._gameloop };
          spawn.x = event.m_x;
          spawn.y = event.m_y;
          spawn.time = loopsToSeconds(spawn.loop - match.loopGameStart);

          match.objective.tributes.push(spawn);
        }
      }
      else if (event._eventid === ReplayTypes.TrackerEvent.UnitDied) {
        // Haunted Mines - check for matching golem death
        if (match.map === ReplayTypes.MapType.Mines) {
          let tag = event.m_unitTagIndex;
          let rtag = event.m_unitTagRecycle;

          for (let g in golems) {
            let golem = golems[g];

            if (golem && golem.unitTagIndex === tag && golem.unitTagRecycle === rtag) {
              let objEvent = { startLoop: golem.loop, startTime: golem.time, endLoop: event._gameloop };
              objEvent.endTime = loopsToSeconds(objEvent.endLoop - match.loopGameStart);
              objEvent.duration = objEvent.endTime - objEvent.startTime;
              objEvent.team = golem.team;
              golems[g] = null;

              console.log('[TRACKER] Team ' + objEvent.team + ' golem lasted for ' + objEvent.duration + ' seconds');

              match.objective[objEvent.team].push(objEvent);
            }
          }
        }
      }
    }

    // mines clean up
    if (match.map === ReplayTypes.MapType.Mines) {
      for (let g in golems) {
        let golem = golems[g];

        if (golem) {
          let objEvent = { startLoop: golem.loop, startTime: golem.time, endLoop: match.loopLength };
          objEvent.endTime = loopsToSeconds(objEvent.endLoop - match.loopGameStart);
          objEvent.duration = objEvent.endTime - objEvent.startTime;
          objEvent.team = golem.team;
          golems[g] = null;

          console.log('[TRACKER] Team ' + objEvent.team + ' golem lasted for ' + objEvent.duration + ' seconds');

          match.objective[objEvent.team].push(objEvent);
        }
      }
    }

    console.log("[TRACKER] Adding final XP breakdown");

    match.XPBreakdown.push(team0XPEnd);
    match.XPBreakdown.push(team1XPEnd);

    console.log("[TRACKER] Event Analysis Complete");

    // get a few more bits of summary data from the players...
    for (let p in players) {
      if (players[p].team === ReplayTypes.TeamType.Blue) {
        match.blueTeamLevel = players[p].gameStats.Level;
      
        if (players[p].win) {
          match.winner = ReplayTypes.TeamType.Blue;
        }
      }
      else if (players[p].team === ReplayTypes.TeamType.Red) {
        match.redTeamLevel = players[p].gameStats.Level;

        if (players[p].win) {
          match.winner = ReplayTypes.TeamType.Red;
        }
      }
    }

    console.log("[MESSAGES] Message Processing Start...");

    var messages = data.messageevents;
    match.messages = [];

    for (let i = 0; i < messages.length; i++) {
      let message = messages[i];

      let msg = {};
      msg.type = message._eventid;

      // don't really care about these
      if (msg.type === ReplayTypes.MessageType.LoadingProgress)
        continue;

      if (!(message._userid.m_userId in playerIDMap))
        continue;

      msg.player = playerIDMap[message._userid.m_userId];
      msg.team = players[msg.player].team;
      msg.recipient = message.m_recipient;
      msg.loop = message._gameloop;
      msg.time = loopsToSeconds(msg.loop - match.loopGameStart);

      if (message._eventid === ReplayTypes.MessageType.Ping) {
        msg.point = { x: message.m_point.x, y: message.m_point.y };
      }
      else if (message._eventid === ReplayTypes.MessageType.Chat) {
        msg.text = message.m_string;
      }
      else if (message._eventid === ReplayTypes.MessageType.PlayerAnnounce) {
        msg.announcement = message.m_announcement;
      }

      match.messages.push(msg);
    }

    console.log("[MESSAGES] Message Processing Complete");

    if ('gameevents' in data) {
      console.log("[GAME] Taunt Detection Running...");

      // this is probably the worst use of cpu cycles i can think of but i'm gonna do it
      var gameLog = data.gameevents;
      var playerBSeq = {};
      for (let i = 0; i < gameLog.length; i++) {
        // the b action is likely of type 27 however i don't actually know how to interpret that data
        // working theory: eventid 27 abilLink 200 is b.
        let event = gameLog[i];
        if (event._eventid === 27) {
          if (event.m_abil && event.m_abil.m_abilLink === 200) {
            // player ids are actually off by one here
            let playerID = event._userid.m_userId + 1;
            let id = playerIDMap[playerID];

            if (!(id in playerBSeq))
              playerBSeq[id] = [];

            // create chains of b-actions. threshold is within 16 loops (1 second)
            if (playerBSeq[id].length === 0)
              playerBSeq[id].push([event]);
            else {
              let currentSeq = playerBSeq[id].length - 1;
              let currentStep = playerBSeq[id][currentSeq].length - 1;
              if (Math.abs(playerBSeq[id][currentSeq][currentStep]._gameloop - event._gameloop) <= 16) {
                playerBSeq[id][currentSeq].push(event);
              }
              else {
                playerBSeq[id].push([event]);
              }
            }
          }
          // taunts and dances
          else if (event.m_abil && event.m_abil.m_abilLink === 19) {
            let playerID = event._userid.m_userId + 1;
            let id = playerIDMap[playerID];

            let eventObj = {};
            eventObj.loop = event._gameloop;
            eventObj.time = loopsToSeconds(event._gameLoop - match.loopGameStart);
            eventObj.kills = 0;
            eventObj.deaths = 0;

            // taunt
            if (event.m_abil.m_abilCmdIndex === 4) {
              players[id].taunts.push(eventObj);
            }
            // dance
            else if (event.m_abil.m_abilCmdIndex === 3) {
              players[id].dances.push(eventObj);
            }
          }
        }
      }

      processTauntData(players, match.takedowns, playerBSeq);
    }

    console.log("[GAME] B-Step Detection Complete");

    return { match, players, status : ReplayStatus.OK };
  }
  catch (err) {
    console.log(err);
    return {status: ReplayStatus.Failure};
  }
}

function processScoreArray(data, match, players, playerIDMap) {
  console.log("[SCORE DATA] Processing Start");

  // iterate through each object...
  for (var i = 0; i < data.length; i++) {
    var name = data[i].m_name;
    var valArray = data[i].m_values;

    if (!name.startsWith('EndOfMatchAward')) {
      for (let j = 0; j < valArray.length; j++) {
        if (valArray[j].length > 0) {
          let playerID = j + 1;
          players[playerIDMap[playerID]].gameStats[name] = valArray[j][0].m_value;
        }
      }
    }
    else {
      for (let j = 0; j < valArray.length; j++) {
        if (valArray[j].length > 0) {
          let playerID = j + 1;
          if (valArray[j][0].m_value === 1) {
            players[playerIDMap[playerID]].gameStats.awards.push(name);
          }
        }
      }
    }
  }

  console.log("[SCORE DATA] Processing Complete");
}

function processTauntData(players, takedowns, playerBSeq) {
  // process the bseq arrays
  for (let id in playerBSeq) {
    let playerSeqs = playerBSeq[id];
    for (let i = 0; i < playerSeqs.length; i++) {
      if (playerSeqs[i].length > 1) {
        // reformat the data and place in the player data
        let bStep = {};
        bStep.start = playerSeqs[i][0]._gameloop;
        bStep.stop = playerSeqs[i][playerSeqs[i].length - 1]._gameloop;
        bStep.duration = bStep.stop - bStep.start;
        bStep.kills = 0;
        bStep.deaths = 0;

        let min = bStep.start - 160;
        let max = bStep.stop + 160;

        // scan the takedowns array to see if anything interesting happened
        // range is +/- 10 seconds (160 loops)
        for (let j = 0; j < takedowns.length; j++) {
          let td = takedowns[j];
          let time = td.loop;

          if (min <= time && time <= max) {
            // check involved players
            if (td.victim === id)
              bStep.deaths += 1;

            if (td.killers.indexOf(id) > -1)
              bStep.kills += 1;
          }
        }

        players[id].bsteps.push(bStep);
      }
    }
  }

  for (let id in players) {
    let player = players[id];

    // taunts
    for (let i = 0; i < player.taunts.length; i++) {
      let tauntTime = player.taunts[i].loop;

      for (let j = 0; j < takedowns.length; j++) {
        let td = takedowns[j];
        let time = td.loop;

        if (Math.abs(tauntTime - time) <= 160) {
          // check involved players
          if (td.victim === id)
            player.taunts[i].deaths += 1;

          if (td.killers.indexOf(id) > -1)
            player.taunts[i].kills += 1;
        }
      }
    }

    // voice lines
    for (let i = 0; i < player.voiceLines.length; i++) {
      let tauntTime = player.voiceLines[i].loop;

      for (let j = 0; j < takedowns.length; j++) {
        let td = takedowns[j];
        let time = td.loop;

        if (Math.abs(tauntTime - time) <= 160) {
          // check involved players
          if (td.victim === id)
            player.voiceLines[i].deaths += 1;

          if (td.killers.indexOf(id) > -1)
            player.voiceLines[i].kills += 1;
        }
      }
    }

    // sprays
    for (let i = 0; i < player.sprays.length; i++) {
      let tauntTime = player.sprays[i].loop;

      for (let j = 0; j < takedowns.length; j++) {
        let td = takedowns[j];
        let time = td.loop;

        if (Math.abs(tauntTime - time) <= 160) {
          // check involved players
          if (td.victim === id)
            player.sprays[i].deaths += 1;

          if (td.killers.indexOf(id) > -1)
            player.sprays[i].kills += 1;
        }
      }

      // dances
      for (let i = 0; i < player.dances.length; i++) {
        let tauntTime = player.dances[i].loop;

        for (let j = 0; j < takedowns.length; j++) {
          let td = takedowns[j];
          let time = td.loop;

          if (Math.abs(tauntTime - time) <= 160) {
            // check involved players
            if (td.victim === id)
              player.dances[i].deaths += 1;

            if (td.killers.indexOf(id) > -1)
              player.dances[i].kills += 1;
          }
        }
      }
    }
  }
}

// general parsing utilities, not db specific
function winFileTimeToDate(filetime) {
  return new Date(filetime / 10000 - 11644473600000);
}

function loopsToSeconds(loops) {
  // apparently hots does 16 updates per second
  return loops / 16;
}

exports.parse = parse;
exports.ReplayDataType = ReplayDataType;
exports.CommonReplayData = CommonReplayData;
exports.AllReplayData = AllReplayData;
exports.processReplay = processReplay;
exports.ReplayStatus = ReplayStatus;
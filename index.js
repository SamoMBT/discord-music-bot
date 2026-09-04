require("dotenv").config();

const fs = require("fs");
const { spawn } = require("child_process");

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  StreamType,
  NoSubscriberBehavior,
  entersState,
} = require("@discordjs/voice");

// =========================
// DISCORD CLIENT
// =========================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// One queue per Discord server.
const queues = new Map();

// =========================
// SLASH COMMANDS
// =========================

const commands = [
  new SlashCommandBuilder()
    .setName("join")
    .setDescription("Join your voice channel"),

  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Play a direct audio URL or YouTube URL")
    .addStringOption(option =>
      option
        .setName("url")
        .setDescription("Direct audio URL or YouTube URL")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("pause")
    .setDescription("Pause playback"),

  new SlashCommandBuilder()
    .setName("resume")
    .setDescription("Resume playback"),

  new SlashCommandBuilder()
    .setName("skip")
    .setDescription("Skip the current song"),

  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Stop music and leave the voice channel"),

  new SlashCommandBuilder()
    .setName("queue")
    .setDescription("Show the music queue"),
].map(command => command.toJSON());

// =========================
// HELPERS
// =========================

function isDirectAudioUrl(url) {
  try {
    const parsed = new URL(url);

    if (!["http:", "https:"].includes(parsed.protocol)) {
      return false;
    }

    return /\.(mp3|m4a|ogg|opus|wav|aac|flac)(\?.*)?$/i.test(
      parsed.pathname + parsed.search
    );
  } catch {
    return false;
  }
}

function isYouTubeUrl(url) {
  try {
    const parsed = new URL(url);

    return (
      parsed.hostname === "youtube.com" ||
      parsed.hostname === "www.youtube.com" ||
      parsed.hostname === "youtu.be" ||
      parsed.hostname.endsWith(".youtube.com")
    );
  } catch {
    return false;
  }
}

function getQueue(guildId) {
  return queues.get(guildId);
}

// =========================
// YT-DLP
// =========================

async function getAudioUrl(url) {
  return new Promise((resolve, reject) => {
    console.log(`🔎 Extracting audio: ${url}`);

    const args = [
      "--js-runtimes",
      "deno",
      "-f",
      "bestaudio/best",
      "-g",
      "--no-playlist",
      "--no-warnings",
    ];

    // Use cookies only if the file actually exists.
    if (fs.existsSync("cookies.txt")) {
      console.log("🍪 Using cookies.txt for yt-dlp.");
      args.push("--cookies", "cookies.txt");
    } else {
      console.log("🍪 No cookies.txt found.");
    }

    args.push(url);

    const yt = spawn("yt-dlp", args);

    let stdout = "";
    let stderr = "";

    yt.stdout.on("data", data => {
      stdout += data.toString();
    });

    yt.stderr.on("data", data => {
      stderr += data.toString();
    });

    yt.on("error", error => {
      console.error("❌ Could not start yt-dlp:", error);

      reject(
        new Error(
          `Could not start yt-dlp: ${error.message}`
        )
      );
    });

    yt.on("close", code => {
      if (code !== 0 || !stdout.trim()) {
        console.error("❌ yt-dlp failed:");
        console.error(stderr.trim());

        if (
          stderr.includes("Sign in to confirm") ||
          stderr.includes("requires verification")
        ) {
          reject(
            new Error(
              "YouTube is blocking audio extraction on this server. Try a direct audio URL instead."
            )
          );
          return;
        }

        reject(
          new Error(
            "yt-dlp could not get an audio stream."
          )
        );

        return;
      }

      const audioUrl = stdout
        .trim()
        .split(/\r?\n/)
        .find(line => line.startsWith("http"));

      if (!audioUrl) {
        reject(
          new Error(
            "yt-dlp returned an invalid audio URL."
          )
        );
        return;
      }

      console.log("✅ yt-dlp returned a valid audio URL.");

      resolve(audioUrl);
    });
  });
}

// =========================
// FFmpeg
// =========================

function startFFmpeg(audioUrl) {
  console.log("🎬 Starting FFmpeg...");

  const ffmpeg = spawn("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "warning",

    "-reconnect",
    "1",
    "-reconnect_streamed",
    "1",
    "-reconnect_delay_max",
    "5",

    "-i",
    audioUrl,

    "-vn",
    "-ac",
    "2",
    "-ar",
    "48000",

    "-f",
    "s16le",
    "pipe:1",
  ]);

  let frameBytes = 0;

  ffmpeg.stdout.on("data", chunk => {
    frameBytes += chunk.length;

    // Don't spam the terminal.
    if (frameBytes <= chunk.length * 2) {
      console.log(
        `🔊 FFmpeg produced audio data: ${chunk.length} bytes`
      );
    }
  });

  ffmpeg.stderr.on("data", data => {
    const text = data.toString().trim();

    if (text) {
      console.log(`FFmpeg: ${text}`);
    }
  });

  ffmpeg.on("error", error => {
    console.error("❌ FFmpeg process error:", error);
  });

  ffmpeg.on("close", code => {
    console.log(
      `🎬 FFmpeg exited with code ${code}. Audio bytes produced: ${frameBytes}`
    );
  });

  return ffmpeg;
}

// =========================
// PLAY SONG
// =========================

async function playSong(guildId) {
  const queue = getQueue(guildId);

  if (!queue || queue.songs.length === 0) {
    return;
  }

  // Prevent two playSong() calls from starting two FFmpeg processes.
  if (queue.playing) {
    return;
  }

  const song = queue.songs[0];

  queue.playing = true;

  try {
    console.log(`🎵 Preparing: ${song.url}`);

    let audioUrl;

    // Direct audio URL.
    if (isDirectAudioUrl(song.url)) {
      console.log("🎧 Direct audio stream detected.");
      audioUrl = song.url;
    }

    // YouTube URL.
    else if (isYouTubeUrl(song.url)) {
      audioUrl = await getAudioUrl(song.url);
    }

    // Anything else.
    else {
      throw new Error(
        "Unsupported URL. Use a YouTube URL or a direct .mp3/.m4a/.ogg/.opus/.wav/.aac/.flac URL."
      );
    }

    if (!audioUrl || !audioUrl.startsWith("http")) {
      throw new Error("Invalid audio stream URL.");
    }

    const ffmpeg = startFFmpeg(audioUrl);

    queue.ffmpeg = ffmpeg;

    const resource = createAudioResource(ffmpeg.stdout, {
      inputType: StreamType.Raw,
      inlineVolume: true,
    });

    resource.volume?.setVolume(1.0);

    queue.player.play(resource);

    console.log("▶️ AudioPlayer play() called.");

    // Wait for actual Playing state.
    try {
      await entersState(
        queue.player,
        AudioPlayerStatus.Playing,
        10_000
      );

      console.log(`🔊 AudioPlayer is PLAYING: ${song.url}`);

      queue.currentlyPlaying = true;
    } catch {
      console.error(
        "❌ AudioPlayer did not enter PLAYING state."
      );

      throw new Error(
        "Audio player failed to start."
      );
    }

  } catch (error) {
    console.error(
      "❌ Playback failed:",
      error.message
    );

    queue.playing = false;
    queue.currentlyPlaying = false;

    if (queue.ffmpeg) {
      queue.ffmpeg.kill("SIGKILL");
      queue.ffmpeg = null;
    }

    // Remove broken song.
    queue.songs.shift();

    // Try the next song.
    if (queue.songs.length > 0) {
      setImmediate(() => {
        playSong(guildId).catch(console.error);
      });
    }

    throw error;
  }
}

// =========================
// AUDIO PLAYER EVENTS
// =========================

function setupPlayerEvents(guildId, player) {
  player.on(AudioPlayerStatus.Playing, () => {
    const queue = getQueue(guildId);

    if (!queue) return;

    queue.currentlyPlaying = true;

    console.log(`🔊 [${guildId}] Player status: PLAYING`);
  });

  player.on(AudioPlayerStatus.Paused, () => {
    console.log(`⏸️ [${guildId}] Player status: PAUSED`);
  });

  player.on(AudioPlayerStatus.Idle, () => {
    const queue = getQueue(guildId);

    if (!queue) return;

    console.log(`⏹️ [${guildId}] Player status: IDLE`);

    queue.playing = false;
    queue.currentlyPlaying = false;

    if (queue.ffmpeg) {
      queue.ffmpeg.kill("SIGKILL");
      queue.ffmpeg = null;
    }

    // Remove finished song.
    if (queue.songs.length > 0) {
      queue.songs.shift();
    }

    // Play next song.
    if (queue.songs.length > 0) {
      setImmediate(() => {
        playSong(guildId).catch(error => {
          console.error(
            "❌ Next song failed:",
            error.message
          );
        });
      });
    }
  });

  player.on("error", error => {
    const queue = getQueue(guildId);

    console.error(
      `❌ [${guildId}] AudioPlayer error:`,
      error
    );

    if (!queue) return;

    queue.playing = false;
    queue.currentlyPlaying = false;

    if (queue.ffmpeg) {
      queue.ffmpeg.kill("SIGKILL");
      queue.ffmpeg = null;
    }

    if (queue.songs.length > 0) {
      queue.songs.shift();
    }

    if (queue.songs.length > 0) {
      setImmediate(() => {
        playSong(guildId).catch(console.error);
      });
    }
  });
}

// =========================
// DISCORD READY
// =========================

client.once("ready", async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);

  console.log(
    `🏠 Connected guilds: ${client.guilds.cache.size}`
  );

  for (const guild of client.guilds.cache.values()) {
    console.log(`   • ${guild.name} (${guild.id})`);
  }

  const rest = new REST({ version: "10" }).setToken(
    process.env.DISCORD_BOT_TOKEN
  );

  try {
    await rest.put(
      Routes.applicationCommands(
        process.env.DISCORD_CLIENT_ID
      ),
      {
        body: commands,
      }
    );

    console.log("✅ Slash commands registered.");
  } catch (error) {
    console.error(
      "❌ Command registration failed:",
      error
    );
  }
});

// =========================
// INTERACTIONS
// =========================

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  console.log(
    `📥 Interaction: ${interaction.commandName} | Guild: ${interaction.guildId} | User: ${interaction.user.tag}`
  );

  if (!interaction.guild) {
    return interaction.reply(
      "❌ This command must be used in a server."
    );
  }

  const guildId = interaction.guild.id;

  // =======================
  // JOIN
  // =======================

  if (interaction.commandName === "join") {
    const voiceChannel =
      interaction.member?.voice?.channel;

    if (!voiceChannel) {
      return interaction.reply(
        "❌ Join a voice channel first."
      );
    }

    try {
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId,
        adapterCreator:
          interaction.guild.voiceAdapterCreator,
        selfDeaf: false,
      });

      await entersState(
        connection,
        VoiceConnectionStatus.Ready,
        15_000
      );

      console.log(
        `🔊 Voice connection READY in ${voiceChannel.name}`
      );

      return interaction.reply(
        `🔊 Joined **${voiceChannel.name}**.`
      );
    } catch (error) {
      console.error(
        "❌ Voice connection failed:",
        error
      );

      return interaction.reply(
        `❌ Could not join the voice channel: ${error.message}`
      );
    }
  }

  // =======================
  // PLAY
  // =======================

    if (interaction.commandName === "play") {
    await interaction.deferReply();

    const url = interaction.options.getString("url");
    const voiceChannel = interaction.member?.voice?.channel;

    if (!voiceChannel) {
      return interaction.editReply(
        "❌ Join a voice channel first."
      );
    }

    try {
      let queue = queues.get(interaction.guild.id);

      if (!queue) {
        const connection = joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId: interaction.guild.id,
          adapterCreator: interaction.guild.voiceAdapterCreator,
          selfDeaf: false,
        });

        await entersState(
          connection,
          VoiceConnectionStatus.Ready,
          15_000
        );

        const player = createAudioPlayer();

        connection.subscribe(player);

        queue = {
          connection,
          player,
          songs: [],
          playing: false,
          ffmpeg: null,
        };

        queues.set(interaction.guild.id, queue);

        setupPlayerEvents(
          interaction.guild.id,
          player
        );

        console.log(
          `🔊 Voice connection ready for ${voiceChannel.name}`
        );
      }

      queue.songs.push({
        url,
        title: url,
      });

      const position = queue.songs.length;

      console.log(
        `📋 Added to queue. Position: ${position}`
      );

      if (queue.playing) {
        return interaction.editReply(
          `📋 Added to queue. Position: **${position}**`
        );
      }

      await interaction.editReply(
        "🎵 Preparing audio..."
      );

      await playSong(interaction.guild.id);

      return interaction.editReply(
        "🎵 Now playing!"
      );

    } catch (error) {
      console.error(
        "❌ Playback failed:",
        error
      );

      return interaction.editReply(
        `❌ ${error.message}`
      );
    }
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
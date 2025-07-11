import * as fs from "fs";
import nodeFetch from "node-fetch";
import * as os from "os";
import * as path from "path";

import { TMDB } from "tmdb-ts";

import joplin from "api";
import { MenuItemLocation, SettingItemType } from "api/types";

const tmdbLinkRegex = new RegExp(
  "https://www.themoviedb.org/(movie|tv)/([0-9]*)"
);
const watchStateRegex = new RegExp("- Watch State: (.*)");
const lastWatchedRegex = new RegExp("- Last Watched: (.*)");
const yearRegex = new RegExp("- Year: (.*)");
const imageRegex = new RegExp(/\!\[\]\(:\/(\w*)\)/);

class DefaultDict {
  // https://stackoverflow.com/a/44622467/7410886
  constructor(defaultInit) {
    return new Proxy(
      {},
      {
        get: (target, name) =>
          name in target
            ? target[name]
            : (target[name] =
                typeof defaultInit === "function"
                  ? new defaultInit().valueOf()
                  : defaultInit),
      }
    );
  }
}

async function download(url, filename) {
  const res = await nodeFetch(url);
  await new Promise<void>((resolve, reject) => {
    const fileStream = fs.createWriteStream(filename);
    res.body.pipe(fileStream);
    res!.body!.on("error", (err) => {
      reject(err);
    });
    fileStream.on("finish", function () {
      resolve();
    });
  });
}

async function searchAndChoose(tmdb, chooseItemDialog, noteTitle) {
  const dialogs = joplin.views.dialogs;

  // tmdb search
  let searchResult;
  try {
    searchResult = await tmdb.search.multi({ query: noteTitle });
    console.log(`collector: found ${searchResult.results.length} notes`);
  } catch (err) {
    console.error(err);
  }

  // create results form
  let form = document.createElement("form");
  form.setAttribute("style", "white-space: nowrap;");
  form.name = "item";
  for (const result of searchResult.results) {
    let id, title, year;
    if (result.media_type === "movie") {
      id = "m" + result.id.toString();
      title = result.title;
      year = result.release_date;
    } else if (result.media_type === "tv") {
      id = "t" + result.id.toString();
      title = result.name;
      year = result.first_air_date;
    } else {
      continue;
    }
    // TODO: radiobuttons are not exclusive
    let input = document.createElement("input");
    input.type = "radio";
    input.id = id;
    input.value = id;
    input.name = title;
    form.appendChild(input);
    let label = document.createElement("label");
    label.htmlFor = id;
    label.textContent = title + ` [${year}]`;
    form.appendChild(label);
    let br = document.createElement("br");
    form.appendChild(br);
  }
  await dialogs.setHtml(
    chooseItemDialog,
    `<p>Select content for ${noteTitle}</p>` + form.outerHTML
  );

  // get selected tmdb result
  const result = await dialogs.open(chooseItemDialog);
  if (result.id === "cancel") return;

  // extract more details from tmdb result
  const formData: [string, string] = result.formData.item;
  const itemId = Object.values(formData)[0];
  const mediaType = itemId[0] === "m" ? "movie" : "tv";
  const tmdbId = Number(itemId.slice(1));
  return [mediaType, tmdbId];
}

async function selectDuplicatesToDelete(
  titleYear,
  candidates,
  deleteDuplicateDialog
) {
  const dialogs = joplin.views.dialogs;

  // create form
  let div = document.createElement("div");
  div.setAttribute("style", "white-space: nowrap;");
  let form = document.createElement("form");
  form.name = "item";
  for (const candidate of candidates) {
    const watchStateMatch = candidate.body.match(watchStateRegex);
    const watchState = watchStateMatch ? watchStateMatch[1] : "undefined";
    const lastWatchedMatch = candidate.body.match(lastWatchedRegex);
    const lastWatched = lastWatchedMatch ? lastWatchedMatch[1] : "undefined";

    let input = document.createElement("input");
    input.type = "checkbox";
    input.id = candidate.id;
    input.value = candidate.id;
    input.name = candidate.id;
    form.appendChild(input);
    let label = document.createElement("label");
    label.htmlFor = candidate.id;
    label.textContent = `${watchState} [${lastWatched}]`;
    form.appendChild(label);
    let br = document.createElement("br");
    form.appendChild(br);
    div.append(form);
  }
  await dialogs.setHtml(
    deleteDuplicateDialog,
    `<p>Select note to delete: ${titleYear}</p>` + form.outerHTML
  );

  // get result of dialog
  const result = await dialogs.open(deleteDuplicateDialog);
  if (result.id === "cancel") return [];

  const formData: [string, string] = result.formData.item;
  return Object.values(formData);
}

function setToString(set) {
  const leadingSpace = set.size == 0 ? "" : " ";
  const content = Array.from(set).join(", ");
  return `${leadingSpace}${content}`;
}

joplin.plugins.register({
  onStart: async function () {
    // Register section
    await joplin.settings.registerSection("collectorSection", {
      label: "Collector",
      iconName: "fas fa-flag-checkered",
    });

    // Register settings
    await joplin.settings.registerSettings({
      tmdbApiToken: {
        value: "",
        type: SettingItemType.String,
        section: "collectorSection",
        label: "TMDB API Token",
        public: true,
      },
      tmdbOverwriteTitle: {
        value: true,
        type: SettingItemType.Bool,
        section: "collectorSection",
        label: "TMDB Overwrite the note title",
        public: true,
      },
      tmdbIncludeThumbnail: {
        value: true,
        type: SettingItemType.Bool,
        section: "collectorSection",
        label: "TMDB Include Thumbnail",
        public: true,
      },
    });

    const dialogs = joplin.views.dialogs;
    const chooseItemDialog = await dialogs.create("availableItemsDialog");
    // https://discourse.joplinapp.org/t/resize-plugin-dialog/14552/6
    await joplin.views.dialogs.addScript(
      chooseItemDialog,
      "./adjust_dialog_size.css"
    );
    const deleteDuplicateDialog = await dialogs.create("deleteDuplicateDialog");

    await joplin.commands.register({
      name: "contextMenuFindDuplicates",
      label: "Collector: Find Duplicates",
      enabledCondition: "oneFolderSelected",
      execute: async (folderId: string, targetIdx?: number) => {
        // get all notes in the folder
        let allNotes = [];
        let page = 1;
        let response;
        do {
          response = await joplin.data.get(["folders", folderId, "notes"], {
            page: page,
            fields: ["id", "title", "body"],
          });
          page += 1;
          allNotes.push(...response.items);
        } while (response.has_more);

        // collect in a dict to identify duplicated titles
        let noteDict = new DefaultDict(Array);
        for (const note of allNotes) {
          const yearMatch = note.body.match(yearRegex);
          const year = yearMatch ? yearMatch[1] : null;
          noteDict[`${note.title} [${year}]`].push({
            id: note.id,
            body: note.body,
          });
        }

        // select duplicates for deletion
        for (const [titleYear, notes] of Object.entries(noteDict)) {
          if (notes.length > 1) {
            const noteIdsToDelete = await selectDuplicatesToDelete(
              titleYear,
              notes,
              deleteDuplicateDialog
            );

            for (const id of noteIdsToDelete) {
              console.log(`collector: delete note ${id}`);
              await joplin.data.delete(["notes", id]);
            }
          }
        }
      },
    });

    await joplin.commands.register({
      name: "contextMenuCollectorFetchData",
      label: "Collector: Fetch Data",
      execute: async (noteIds: string[]) => {
        const tmdbApiToken = await joplin.settings.value("tmdbApiToken");
        if (!tmdbApiToken) {
          alert(
            "Collector: Please specify a TMDB API token in the plugin settings."
          );
          return;
        }
        const tmdb = new TMDB(tmdbApiToken);

        const testResponse = await tmdb.discover.movie();
        if ("success" in testResponse && !testResponse.success) {
          const errorDetails =
            "status_message" in testResponse
              ? testResponse.status_message
              : "Please check the TMDB API token in the plugin settings.";
          alert(`Collector: TMDB access doesn't work. ${errorDetails}`);
          return;
        }

        for (const noteId of noteIds) {
          const note = await joplin.data.get(["notes", noteId], {
            fields: ["title", "body"],
          });
          console.log(`collector: note ${note.title}`);

          let overwrite = false;
          let mediaType;
          let tmdbId;

          const tmdbLinkMatch = note.body.match(tmdbLinkRegex);
          if (tmdbLinkMatch) {
            // take the media type and tmdb id from the note body if possible
            console.log(`collector: found tmdb link ${tmdbLinkMatch}`);
            [mediaType, tmdbId] = tmdbLinkMatch.slice(1);
            // overwrite all data in the note
            overwrite = true;
          } else {
            // TODO: throws an exception if null is returned
            [mediaType, tmdbId] = await searchAndChoose(
              tmdb,
              chooseItemDialog,
              note.title
            );
          }

          // TODO: german title: https://github.com/blakejoy/tmdb-ts/issues/39
          console.log(`collector: fetch details: ${mediaType} ${tmdbId}`);
          let details;
          let credits;
          let providers;
          let title;
          let originalTitle;
          let year;
          if (mediaType === "movie") {
            details = await tmdb.movies.details(tmdbId);
            title = details.title;
            originalTitle = details.original_title;
            year = details.release_date;
            credits = await tmdb.movies.credits(tmdbId);
            providers = await tmdb.movies.watchProviders(tmdbId);
          } else if (mediaType === "tv") {
            details = await tmdb.tvShows.details(tmdbId);
            title = details.name;
            originalTitle = details.original_name;
            year = details.first_air_date;
            credits = await tmdb.tvShows.aggregateCredits(tmdbId);
            providers = await tmdb.tvShows.watchProviders(tmdbId);
          }

          let providersFiltered = new Set();
          if ("results" in providers && "DE" in providers.results) {
            const rentFlatrateProviders = (
              providers.results.DE.ads || []
            ).concat(
              providers.results.DE.flatrate || [],
              providers.results.DE.rent || []
            );
            for (const provider of rentFlatrateProviders) {
              if (provider.provider_name.includes("Amazon")) {
                providersFiltered.add("Amazon");
              } else if (provider.provider_name.includes("Joyn")) {
                providersFiltered.add("Joyn");
              } else if (provider.provider_name.includes("Netflix")) {
                providersFiltered.add("Netflix");
              } else if (provider.provider_name.includes("Paramount")) {
                providersFiltered.add("Paramount");
              } else if (provider.provider_name.includes("Sky")) {
                providersFiltered.add("Sky");
              } else if (provider.provider_name.includes("Youtube")) {
                providersFiltered.add("Youtube");
              } else {
                providersFiltered.add(provider.provider_name);
              }
            }
          } else {
            console.log("collector: couldn't fetch providers");
          }

          let jobDict = new DefaultDict(Set);
          for (const person of credits.crew) {
            // compensate the difference between credits and aggregateCredits
            const jobs = person.job
              ? [person.job]
              : person.jobs.map((item) => item.job);
            for (const job of jobs) {
              jobDict[job].add(person.name);
            }
          }

          // parse personal data from existing note
          const watchStateMatch = note.body.match(watchStateRegex);
          const watchState = watchStateMatch ? watchStateMatch[1] : "TBD";
          // https://stackoverflow.com/a/35922073/7410886
          const lastWatchedMatch = note.body.match(lastWatchedRegex);
          const lastWatched = lastWatchedMatch
            ? lastWatchedMatch[1]
            : new Date().toISOString().slice(0, 10);

          const newContentArray = [
            `- Watch State: ${watchState}`,
            `- Last Watched: ${lastWatched}`,
            `- Original Title: ${originalTitle}`,
            `- Year: ${year.slice(0, 4)}`,
            `- TMDB ID: [${tmdbId}](https://www.themoviedb.org/${mediaType}/${tmdbId})`,
            `- Media Type: ${mediaType === "tv" ? "Series" : "Movie"}`,
            `- Genres: ${details.genres.map((genre) => genre.name).join(", ")}`,
            `- Providers:${setToString(providersFiltered)}`,
            `- Cast: ${credits.cast
              .slice(0, 10)
              .map((person) => person.name)
              .join(", ")}`,
            "- Crew:",
            `  - Directors:${setToString(jobDict["Director"])}`,
            `  - Producers:${setToString(jobDict["Producer"])}`,
            `  - Writers:${setToString(jobDict["Screenplay"])}`,
            `  - Composers:${setToString(jobDict["Original Music Composer"])}`,
            `- Plot: ${details.overview}`,
          ];

          // update the Joplin note
          const newContent = newContentArray.join("\n");
          let noteBody =
            !note.body || overwrite
              ? newContent
              : `${newContent}\n\n***\n\n` + note.body;

          if (await joplin.settings.value("tmdbIncludeThumbnail")) {
            const imageMatch = note.body.match(imageRegex);
            if (imageMatch) {
              // take the ressource id that is already in the note
              noteBody += `\n\n![](:/${imageMatch[1]})`;
            } else if (details.poster_path) {
              // download and attach the image as new ressource

              // strip the leading slash, so we dont need to create a new dir
              const tempFile = path.join(
                os.tmpdir(),
                "joplin_collector_" + details.poster_path.slice(1)
              );
              // image sizes: https://www.themoviedb.org/talk/53c11d4ec3a3684cf4006400
              await download(
                "https://image.tmdb.org/t/p/w185" + details.poster_path,
                tempFile
              );

              // https://github.com/personalizedrefrigerator/joplin-plugin-freehand-drawing/blob/3026eff1aa9a6436bc4b90eea6b931cfabcfa568/src/Resource.ts#L146
              let resource;
              try {
                resource = await joplin.data.post(
                  ["resources"],
                  null,
                  { title: details.poster_path.slice(1) },
                  [{ path: tempFile }]
                );
                noteBody += `\n\n![](:/${resource.id})`;
              } catch (error) {
                console.error("collector: creating resource failed");
                console.error(error);
              }
            }
          }

          noteBody += "\n"  // final newline

          const overwriteTitle = await joplin.settings.value(
            "tmdbOverwriteTitle"
          );
          await joplin.data.put(["notes", noteId], null, {
            // overwrite the user-written title if configured
            ...(overwriteTitle && { title: title }),
            // always update the note body
            ...{body: noteBody},
          });
        }
      },
    });
    await joplin.views.menuItems.create(
      "contextMenuCollectorFetchData",
      "contextMenuCollectorFetchData",
      MenuItemLocation.NoteListContextMenu
    );
    await joplin.views.menuItems.create(
      "contextMenuFindDuplicates",
      "contextMenuFindDuplicates",
      MenuItemLocation.FolderContextMenu
    );
  },
});

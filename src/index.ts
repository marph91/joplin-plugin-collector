import { TMDB } from "tmdb-ts";

import joplin from "api";
import { MenuItemLocation, SettingItemType } from "api/types";

const tmdbLinkRegex = new RegExp("https://www.themoviedb.org/(movie|tv)/([0-9]*)");
const watchStateRegex = new RegExp("- watch state: (.*)");
const lastWatchedRegex = new RegExp("- last watched: (.*)");

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

joplin.plugins.register({
  onStart: async function () {
    await joplin.settings.registerSettings({
      tmdbApiToken: {
        value: "",
        type: SettingItemType.String,
        section: "collectorSection",
        label: "TMDB API Token",
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
            [mediaType, tmdbId] = await searchAndChoose(
              tmdb,
              chooseItemDialog,
              note.title
            );
          }

          //////////////////
          // {
          //   import { TMDB } from "tmdb-ts";
          //   const tmdb = new TMDB("myKey");
          //   const tmdbId = 87739;
          //   const credits = await tmdb.tvShows.credits(tmdbId);
          //   const providers = await tmdb.movies.watchProviders(tmdbId);
          //   console.log(credits);
          //   console.log(providers);
          // }
          //////////////////

          console.log(`collector: fetch details: ${mediaType} ${tmdbId}`);
          let details;
          let credits;
          let providers;
          let title;
          let year;
          if (mediaType === "movie") {
            details = await tmdb.movies.details(tmdbId);
            title = details.title;
            year = details.release_date;
            credits = await tmdb.movies.credits(tmdbId);
            providers = await tmdb.movies.watchProviders(tmdbId);
          } else if (mediaType === "tv") {
            details = await tmdb.tvShows.details(tmdbId);
            title = details.name;
            year = details.first_air_date;
            credits = await tmdb.tvShows.credits(tmdbId);
            providers = await tmdb.movies.watchProviders(tmdbId);
          }

          let providersFiltered = new Set();
          if ("results" in providers && "DE" in providers.results) {
            for (const provider of providers.results.DE.rent) {
              if (provider.provider_name.includes("Amazon")) {
                providersFiltered.add("Amazon");
              } else if (provider.provider_name.includes("Joyn")) {
                providersFiltered.add("Joyn");
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

          let directors = [];
          let producers = [];
          let writers = [];
          let composers = [];
          for (const person of credits.crew) {
            switch (person.job) {
              case "Director":
                directors.push(person.name);
                break;
              case "Producer":
                producers.push(person.name);
                break;
              case "Screenplay":
                writers.push(person.name);
                break;
              case "Original Music Composer":
                composers.push(person.name);
                break;
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
            `- watch state: ${watchState}`,
            `- last watched: ${lastWatched}`,
            `- original title: ${title}`,
            `- year: ${year.slice(0, 4)}`,
            `- tmdb id: [${tmdbId}](https://www.themoviedb.org/${mediaType}/${tmdbId})`,
            `- media type: ${mediaType === "tv" ? "series" : "movie"}`,
            `- genres: ${details.genres.map((genre) => genre.name).join(", ")}`,
            `- providers: ${Array.from(providersFiltered).join(", ")}`,
            `- cast: ${credits.cast
              .slice(0, 10)
              .map((person) => person.name)
              .join(", ")}`,
            `- directors: ${directors.join(", ")}`,
            `- producers: ${producers.join(", ")}`,
            `- writers: ${writers.join(", ")}`,
            `- composers: ${composers.join(", ")}`,
            `- plot: ${details.overview}`,
          ];

          // update the Joplin note
          const newContent = newContentArray.join("\n");
          const noteBody =
            !note.body || overwrite
              ? newContent
              : `${newContent}\n\n***\n\n` + note.body;
          // related: https://discourse.joplinapp.org/t/how-to-show-the-newest-note-after-using-data-put/22797
          // instantly update the note body of the current note
          await joplin.commands.execute("editor.setText", noteBody);
          // permanently update the note body
          await joplin.data.put(["notes", noteId], null, {
            // keep the user-written title
            // title: title,
            body: noteBody,
          });
        }
      },
    });
    await joplin.views.menuItems.create(
      "contextMenuCollectorFetchData",
      "contextMenuCollectorFetchData",
      MenuItemLocation.NoteListContextMenu
    );
  },
});

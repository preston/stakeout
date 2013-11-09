Stakeout
----

A fantastically simple, one-page dashboard for SaaS availability checks. Supports HTTP, HTTPS, ICMP Ping, and automatic screenshots. (For the screenshot feature to work, you'll need PhantomJS installed! http://phantomjs.org/) Stakeout is a Ruby on Rails application utilizing jQuery and Bootstrap.

![Screenshot](https://raw.github.com/preston/stakeout/master/app/assets/images/screenshots/1.png)

Stakeout is designed to be *extremely* simple to use, and does not support complex services, or really anything outside of basic HTTP(S) and ICMP. So if you're looking for Nagios, use Nagios. :)  No built-in authentication or authorization is provided, so for Internet-facing deployments you'll want to implement a challenge at the web server, such as HTTP Basic Auth.


Todo
----

* Client-side JavaScript needs to be refactored to be asynchronous to not show the "Be cool!" dialog.
* Server should probably automatically capture screenshots at periodic intervals.. maybe?


Attribution
----

Designed and written by Preston Lee.


License
----

Released under the MIT license.
